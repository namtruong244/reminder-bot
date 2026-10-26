import { Context } from 'hono';
import { Env } from '../types/env';
import { TaskRecord, TelegramInlineKeyboardMarkup, TelegramUpdate } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
import { BotCommands } from './commands';
import { NlpService } from '../services/nlp.service';
import {
  createTaskCreatedKeyboard,
  createReschedKeyboard,
  createUndoKeyboard,
  MENU_COMMANDS,
} from './keyboards';
import { renderCreatedMessage, renderTaskCard } from './messages';
import {
  toUtcIso,
  addMinutes,
  formatFriendlyDate,
  formatTimeOnly,
  calculateNextRecurrence,
  getTomorrowMorningIso,
  getLocalDateParts,
  getTimezoneOffsetString,
  escapeMarkdown,
  DEFAULT_TZ,
} from '../utils/datetime';

// Bounded in-memory cache of processed Telegram update_ids for idempotency within an isolate
const processedUpdateIds = new Set<number>();
const MAX_PROCESSED_IDS = 1000;

function markUpdateProcessed(updateId: number): boolean {
  if (typeof updateId !== 'number') return true;
  if (processedUpdateIds.has(updateId)) {
    return false;
  }
  if (processedUpdateIds.size >= MAX_PROCESSED_IDS) {
    const oldest = processedUpdateIds.values().next().value;
    if (oldest !== undefined) {
      processedUpdateIds.delete(oldest);
    }
  }
  processedUpdateIds.add(updateId);
  return true;
}

export class TelegramWebhookHandler {
  private telegram: TelegramApi;
  private taskService: TaskService;
  private commands: BotCommands;
  private nlpService: NlpService;

  constructor(private env: Env) {
    this.telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    this.taskService = new TaskService(env.DB);
    this.nlpService = new NlpService(env.GEMINI_API_KEY, env.LLM_MODEL);
    this.commands = new BotCommands(env, this.telegram, this.taskService, this.nlpService);
  }

  private safeWaitUntil(c: Context<{ Bindings: Env }>, promise: Promise<unknown>): void {
    try {
      if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
        c.executionCtx.waitUntil(promise);
      }
    } catch {
      // ExecutionContext is not bound in local unit tests
    }
  }

  async handleUpdate(c: Context<{ Bindings: Env }>): Promise<Response> {
    // 1. Security Check: Telegram Secret Token (never log expectedSecret in plaintext)
    const expectedSecret = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
      if (headerSecret !== expectedSecret) {
        console.warn('Telegram webhook secret token mismatch.');
        return c.text('Unauthorized', 401);
      }
    }

    let update: TelegramUpdate;
    try {
      update = await c.req.json<TelegramUpdate>();
    } catch {
      return c.text('Invalid JSON', 400);
    }

    // Idempotency guard against duplicate Telegram webhook retries (shared across isolates via D1)
    if (typeof update.update_id === 'number' && !(await this.claimUpdate(update.update_id))) {
      return c.text('OK', 200);
    }

    // Acknowledge immediately: NLP (Gemini) can take several seconds and Telegram retries slow webhooks.
    await this.runInBackground(c, this.processUpdate(c, update));
    return c.text('OK', 200);
  }

  /**
   * Claims the update_id in D1. If D1 is unavailable (e.g. migration 0002 not applied yet),
   * degrade to the per-isolate in-memory guard instead of dropping the update.
   */
  private async claimUpdate(updateId: number): Promise<boolean> {
    try {
      return await this.taskService.claimTelegramUpdate(updateId);
    } catch (err) {
      console.warn('processed_updates claim failed, using in-memory guard:', err);
      return markUpdateProcessed(updateId);
    }
  }

  /**
   * Runs work after the HTTP response via ctx.waitUntil; without an ExecutionContext
   * (unit tests, local scripts) it is awaited inline so nothing is silently dropped.
   */
  private async runInBackground(c: Context<{ Bindings: Env }>, work: Promise<unknown>): Promise<void> {
    let scheduled = false;
    try {
      if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
        c.executionCtx.waitUntil(work);
        scheduled = true;
      }
    } catch {
      // ExecutionContext is not bound
    }
    if (!scheduled) await work;
  }

  private async processUpdate(c: Context<{ Bindings: Env }>, update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(c, update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(c, update.callback_query);
      }
    } catch (err) {
      console.error('Unhandled error in Telegram webhook handler:', err);
      const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
      if (chatId) {
        try {
          await this.telegram.sendMessage(
            chatId,
            `😵 *Có lỗi xảy ra khi xử lý yêu cầu.*\n\nBạn thử gửi lại giúp mình nhé. Nếu vẫn lỗi, gõ /start để khởi tạo lại.`,
            { parse_mode: 'Markdown' }
          );
        } catch {
          // Ignore secondary send failures
        }
      }
    }
  }

  private async handleMessage(
    c: Context<{ Bindings: Env }>,
    message: NonNullable<TelegramUpdate['message']>
  ): Promise<void> {
    const chatId = message.chat.id;
    const userId = message.from?.id || chatId;
    const username = message.from?.username || null;

    const text = (message.text || message.caption)?.trim();
    if (!text) {
      if (message.voice || message.audio) {
        await this.telegram.sendMessage(
          chatId,
          '🎙 Hiện tại bot chưa hỗ trợ giải mã trực tiếp file âm thanh. Bạn hãy dùng nút *Đọc chính tả (biểu tượng micro trên bàn phím điện thoại)* để chuyển giọng nói thành văn bản rồi gửi nhé!',
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // Send instant typing action so user knows bot is working immediately
    this.safeWaitUntil(c, this.telegram.sendChatAction(chatId, 'typing'));

    // Persistent bottom-menu buttons arrive as plain text; map them to commands
    const menuCommand = MENU_COMMANDS[text];
    if (menuCommand) {
      await this.commands.handleCommand({ ...message, text: menuCommand });
      return;
    }

    // Check if it is a bot command
    if (text.startsWith('/')) {
      await this.commands.handleCommand(message);
      return;
    }

    // Ensure user is registered in D1
    const user = await this.taskService.upsertUser({
      telegram_id: userId,
      username,
    });
    const tz = user.timezone || DEFAULT_TZ;

    // Call NLP Engine with Gemini Structured Outputs
    const nlpResult = await this.nlpService.parseUserPrompt(text, tz);

    if (nlpResult.intent === 'LIST_TASKS') {
      const wantsToday = /hôm\s+nay|today/i.test(text);
      const listCmdMsg = { ...message, text: wantsToday ? '/today' : '/list' };
      await this.commands.handleCommand(listCmdMsg);
      return;
    }

    if (nlpResult.intent === 'CANCEL_TASK') {
      await this.telegram.sendMessage(
        chatId,
        'Để hủy công việc, vui lòng gõ /list và bấm nút "🗑 Hủy" tương ứng.'
      );
      return;
    }

    if (nlpResult.intent === 'CREATE_TASK' && nlpResult.title) {
      const taskId = crypto.randomUUID();

      let dueAtUtc: string;
      if (nlpResult.due_at_iso) {
        try {
          dueAtUtc = toUtcIso(nlpResult.due_at_iso, tz);
        } catch {
          dueAtUtc = addMinutes(new Date(), 30);
        }
      } else {
        dueAtUtc = addMinutes(new Date(), 30);
      }

      // Calculate remind_at intelligently
      const nowMs = Date.now();
      const dueMs = new Date(dueAtUtc).getTime();

      // Refuse times that are already past (model/regex error or stale date) instead of firing instantly
      if (dueMs < nowMs - 60_000) {
        await this.telegram.sendMessage(
          chatId,
          `⚠️ Thời điểm mình hiểu được là *${formatFriendlyDate(dueAtUtc, tz)}* — đã qua rồi. Bạn nhắn lại kèm ngày giờ cụ thể giúp mình nhé (ví dụ: _"9h sáng mai ..."_).`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      const diffMinutes = Math.round((dueMs - nowMs) / 60000);

      // If user scheduled something soon (<= 30 mins) or remindBefore would be in the past, ring exactly on time
      let remindBeforeMin = nlpResult.remind_before_minutes ?? (diffMinutes > 45 ? 15 : 0);
      if (diffMinutes <= 30 || diffMinutes <= remindBeforeMin) {
        remindBeforeMin = 0;
      }

      const remindAtUtc =
        remindBeforeMin > 0
          ? addMinutes(dueAtUtc, -remindBeforeMin)
          : dueAtUtc;
      const priority = nlpResult.priority || 'MEDIUM';
      const nagging = nlpResult.nagging_mode ? 1 : 0;

      // Save to D1
      const createdTask = await this.taskService.createTask({
        id: taskId,
        user_id: userId,
        title: nlpResult.title,
        description: nlpResult.description,
        due_at: dueAtUtc,
        remind_at: remindAtUtc,
        priority,
        nagging_mode: nagging,
        recurrence_rule: nlpResult.recurrence_rrule,
      });

      const confirmText = renderCreatedMessage(createdTask, tz, {
        timeAssumed: !!nlpResult.time_assumed,
        aiFallback: !!nlpResult.debug && nlpResult.debug.source !== 'GEMINI',
      });

      await this.telegram.sendMessage(chatId, confirmText, {
        parse_mode: 'Markdown',
        reply_markup: createTaskCreatedKeyboard(taskId, !!nlpResult.time_assumed),
      });
      return;
    }

    // Default response if prompt could not be parsed into a task
    let failMsg = `🤔 *Mình chưa hiểu bạn muốn nhắc việc gì.*\n\nHãy nhắn kèm thời gian, ví dụ:\n• _"9h sáng mai họp với phòng kinh doanh"_\n• _"Nhắc tôi uống thuốc sau 15 phút nữa, việc gấp"_`;
    if (nlpResult.debug && nlpResult.debug.source !== 'GEMINI') {
      failMsg += `\n\n⚠️ _AI đang bận nên mình chỉ dùng bộ phân tích dự phòng. Bạn thử lại sau ít phút nhé._`;
    }

    await this.telegram.sendMessage(chatId, failMsg, { parse_mode: 'Markdown' });
  }

  /**
   * Loads a task and verifies the tapping user owns it; answers the callback with a toast otherwise.
   */
  private async loadOwnedTask(
    query: NonNullable<TelegramUpdate['callback_query']>,
    taskId: string | undefined
  ): Promise<TaskRecord | null> {
    const task = taskId ? await this.taskService.getTaskById(taskId) : null;
    if (!task) {
      await this.telegram.answerCallbackQuery(query.id, 'Công việc không còn tồn tại.');
      return null;
    }
    if (task.user_id !== query.from.id) {
      await this.telegram.answerCallbackQuery(query.id, 'Bạn không có quyền thao tác trên công việc này.', true);
      return null;
    }
    return task;
  }

  private async handleCallbackQuery(
    c: Context<{ Bindings: Env }>,
    query: NonNullable<TelegramUpdate['callback_query']>
  ): Promise<void> {
    const data = query.data;
    if (!data) {
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    const chatId = query.message?.chat.id || query.from.id;
    const messageId = query.message?.message_id;
    const parts = data.split(':');
    const [action, subAction] = parts;

    if (action !== 'action') {
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    // done/cancel/edit/back/undo: action:{sub}:{id}[:ctx]; snooze/resched: action:{sub}:{arg}:{id}
    const hasArg = subAction === 'snooze' || subAction === 'resched';
    const taskId = hasArg ? parts[3] : parts[2];
    const arg = hasArg ? parts[2] : undefined;
    const listContext = !hasArg && (parts[3] === 'l' || parts[3] === 't') ? (parts[3] as 'l' | 't') : null;

    const user = await this.taskService.getUser(query.from.id);
    const tz = user?.timezone || DEFAULT_TZ;

    const task = await this.loadOwnedTask(query, taskId);
    if (!task) return;

    const show = async (text: string, replyMarkup?: TelegramInlineKeyboardMarkup) => {
      if (messageId) {
        await this.telegram.editMessageText(chatId, messageId, text, {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
      }
    };

    /** Redraws the list the tap came from (keeps the user in the list instead of replacing it). */
    const refreshList = async (ctx: 'l' | 't') => {
      const view = await this.commands.renderListView(query.from.id, ctx);
      await show(view.text, view.keyboard);
    };

    const toast = (text: string) =>
      this.telegram.answerCallbackQuery(query.id, text.length > 120 ? `${text.slice(0, 117)}…` : text);

    // Inline keyboard shortcuts that never change data
    if (subAction === 'edit') {
      if (messageId) await this.telegram.editMessageReplyMarkup(chatId, messageId, createReschedKeyboard(task.id));
      await this.telegram.answerCallbackQuery(query.id, 'Chọn giờ mới');
      return;
    }
    if (subAction === 'back') {
      if (messageId) await this.telegram.editMessageReplyMarkup(chatId, messageId, createTaskCreatedKeyboard(task.id));
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    if (subAction === 'undo') {
      if (task.status === 'PENDING') {
        await toast('Việc này đang hoạt động rồi.');
        return;
      }
      const restored = await this.taskService.restoreTask(task.id);
      if (restored) {
        await show(`↩️ *Đã khôi phục*\n\n${renderTaskCard(restored, tz)}`, createTaskCreatedKeyboard(restored.id));
      }
      await toast('Đã khôi phục công việc');
      return;
    }

    // Everything below only makes sense for open tasks (also makes double taps harmless)
    if (task.status !== 'PENDING') {
      await toast(task.status === 'COMPLETED' ? 'Việc này đã hoàn thành rồi.' : 'Việc này đã bị hủy.');
      return;
    }

    if (subAction === 'done') {
      if (task.recurrence_rule) {
        const next = calculateNextRecurrence(task.due_at, task.remind_at, task.recurrence_rule, tz);
        await this.taskService.completeTask(task.id, next);
        if (listContext) {
          await refreshList(listContext);
        } else {
          await show(
            `✅ *Xong lần này*\n📌 ${escapeMarkdown(task.title)}\n🔄 Lần kế tiếp: ${formatFriendlyDate(next.dueAt, tz)}`
          );
        }
        await toast(`Đã xong lần này · kế tiếp ${formatFriendlyDate(next.dueAt, tz)}`);
        return;
      }

      await this.taskService.completeTask(task.id);
      if (listContext) {
        await refreshList(listContext);
      } else {
        await show(
          `✅ *Đã hoàn thành lúc ${formatTimeOnly(new Date().toISOString(), tz)}*\n📌 ${escapeMarkdown(task.title)}`,
          createUndoKeyboard(task.id)
        );
      }
      await toast(`✅ Đã xong: ${task.title}`);
      return;
    }

    if (subAction === 'cancel') {
      await this.taskService.cancelTask(task.id);
      if (listContext) {
        await refreshList(listContext);
      } else {
        await show(`🗑 *Đã hủy nhắc việc*\n📌 ${escapeMarkdown(task.title)}`, createUndoKeyboard(task.id));
      }
      await toast(`🗑 Đã hủy: ${task.title}`);
      return;
    }

    if (subAction === 'snooze') {
      let newRemindAt: string;
      let note: string;
      if (arg === 'tomorrow') {
        newRemindAt = getTomorrowMorningIso(tz, 9, 0);
        note = 'đến 9:00 sáng mai';
      } else {
        const mins = parseInt(arg ?? '', 10) || 15;
        newRemindAt = addMinutes(new Date(), mins);
        note = mins >= 60 && mins % 60 === 0 ? `${mins / 60} giờ` : `${mins} phút`;
      }

      await this.taskService.snoozeTask(task.id, newRemindAt);
      await show(
        `💤 *Đã hoãn ${note}*\n📌 ${escapeMarkdown(task.title)}\n⏰ Nhắc lại: ${formatFriendlyDate(newRemindAt, tz)}`
      );
      await toast(`Đã hoãn ${note}`);
      return;
    }

    if (subAction === 'resched') {
      let newDue: string;
      if (arg === 'tomorrow') {
        newDue = getTomorrowMorningIso(tz, 9, 0);
      } else if (arg === 'tomorrow14') {
        newDue = getTomorrowMorningIso(tz, 14, 0);
      } else if (arg === 'tonight') {
        const today = getLocalDateParts(new Date(), tz);
        const iso = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}T20:00:00${getTimezoneOffsetString(new Date(), tz)}`;
        newDue = toUtcIso(iso, tz);
        // 20:00 already gone -> next evening
        if (new Date(newDue).getTime() <= Date.now()) newDue = addMinutes(newDue, 24 * 60);
      } else {
        newDue = addMinutes(new Date(), 60);
      }

      const updated = await this.taskService.rescheduleTask(task.id, newDue);
      if (updated) {
        await show(`✏️ *Đã đổi giờ*\n\n${renderTaskCard(updated, tz)}`, createTaskCreatedKeyboard(updated.id));
      }
      await toast(`Đã đổi sang ${formatFriendlyDate(newDue, tz)}`);
      return;
    }

    await this.telegram.answerCallbackQuery(query.id);
  }
}
