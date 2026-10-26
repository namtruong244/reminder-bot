import { Context } from 'hono';
import { Env } from '../types/env';
import { TaskRecord, TelegramUpdate, UserRecord } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
import { BotCommands } from './commands';
import { NlpService } from '../services/nlp.service';
import { createTaskCreatedKeyboard } from './keyboards';
import {
  toUtcIso,
  addMinutes,
  formatDisplayDate,
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
      if (chatId) {
        try {
          await this.telegram.sendMessage(
            chatId,
            `⚠️ *Lỗi xử lý:* \`${escapeMarkdown(errorMsg)}\`\n\nVui lòng thử lại hoặc gõ /start để khởi tạo.`,
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
          `⚠️ Thời điểm tôi hiểu được là *${formatDisplayDate(dueAtUtc, tz)}* — đã qua rồi. Bạn nhắn lại kèm ngày giờ cụ thể giúp tôi nhé (ví dụ: _"9h sáng mai ..."_).`,
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

      // Format confirmation response
      const priorityLabel =
        priority === 'CRITICAL' ? '🔴 KHẨN CẤP' :
        priority === 'HIGH' ? '🟠 CAO' :
        priority === 'LOW' ? '🟢 THẤP' : '🔵 TRUNG BÌNH';

      let confirmText = `
✅ *Đã tạo nhắc nhở thành công!*

📌 Tiêu đề: *${escapeMarkdown(createdTask.title)}*
⏰ Hạn chót: *${formatDisplayDate(createdTask.due_at, tz)}*
🔔 Nhắc lúc: *${formatDisplayDate(createdTask.remind_at, tz)}*
⚡ Mức độ: *${priorityLabel}*
      `.trim();

      if (createdTask.recurrence_rule) {
        confirmText += `\n🔄 Lặp lại: \`${createdTask.recurrence_rule}\``;
      }
      if (nagging === 1) {
        confirmText += `\n⚠️ Chế độ nhắc liên tục (mỗi 10 phút) đã được kích hoạt.`;
      }
      if (nlpResult.time_assumed) {
        confirmText += `\n\n❓ _Tin nhắn chưa nói rõ giờ nên tôi tạm đặt sau 30 phút. Bấm nút bên dưới để chỉnh nhanh._`;
      }
      confirmText += `\n📱 _iOS: Đang chờ đồng bộ (ios_synced: 0)_`;

      if (nlpResult.debug) {
        if (nlpResult.debug.source === 'GEMINI') {
          confirmText += `\n\n🤖 _Phân tích bởi: Gemini ${nlpResult.debug.model || 'Flash'} (${nlpResult.debug.latency_ms || 0}ms)_`;
        } else if (nlpResult.debug.source === 'REGEX_NO_API_KEY') {
          confirmText += `\n\n⚠️ _Phân tích bởi: Regex (Lý do: Chưa cài đặt GEMINI_API_KEY trên Cloudflare Secrets! Dùng /debug để xem hướng dẫn)_`;
        } else {
          confirmText += `\n\n⚠️ _Phân tích bởi: Regex dự phòng (Lỗi Gemini: ${escapeMarkdown(nlpResult.debug.error || 'Timeout/Error')})_`;
        }
      }

      await this.telegram.sendMessage(chatId, confirmText, {
        parse_mode: 'Markdown',
        reply_markup: createTaskCreatedKeyboard(taskId, !!nlpResult.time_assumed),
      });
      return;
    }

    // Default response if prompt could not be parsed into a task
    let failMsg = `Tôi chưa hiểu rõ yêu cầu nhắc việc của bạn. Hãy thử nhắn rõ thời gian, ví dụ:\n• _"9h sáng mai họp với phòng kinh doanh"_\n• _"Nhắc tôi uống thuốc sau 15 phút nữa, việc gấp"_`;
    if (nlpResult.debug) {
      if (nlpResult.debug.source === 'REGEX_NO_API_KEY') {
        failMsg += `\n\n⚠️ _[Debug] Chưa cấu hình GEMINI_API_KEY trên Cloudflare Secrets! Bot đang chạy Regex dự phòng._`;
      } else if (nlpResult.debug.error) {
        failMsg += `\n\n🔍 _[Debug] Lỗi Gemini: ${escapeMarkdown(nlpResult.debug.error)}_`;
      }
    }

    await this.telegram.sendMessage(chatId, failMsg, { parse_mode: 'Markdown' });
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
    const [action, subAction, paramId] = parts;

    if (action !== 'action') {
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    const user = await this.taskService.getUser(query.from.id);
    const tz = user?.timezone || DEFAULT_TZ;

    if (subAction === 'done') {
      const taskId = paramId;
      const task = await this.taskService.getTaskById(taskId);

      if (!task) {
        await this.telegram.answerCallbackQuery(query.id, 'Công việc không tồn tại!');
        return;
      }

      if (task.user_id !== query.from.id) {
        await this.telegram.answerCallbackQuery(
          query.id,
          'Bạn không có quyền thao tác trên công việc này!',
          true
        );
        return;
      }

      const safeTitle = escapeMarkdown(task.title);

      if (task.recurrence_rule) {
        // Calculate next recurrence for recurring tasks in user's timezone
        const next = calculateNextRecurrence(task.due_at, task.remind_at, task.recurrence_rule, tz);
        await this.taskService.completeTask(taskId, next);

        if (messageId) {
          const editMsg = `✅ *Đã hoàn thành lần này!*\n📌 ${safeTitle}\n⏰ Lần nhắc kế tiếp: *${formatDisplayDate(next.remindAt, tz)}*`;
          await this.telegram.editMessageText(chatId, messageId, editMsg, { parse_mode: 'Markdown' });
        }
      } else {
        await this.taskService.completeTask(taskId);

        if (messageId) {
          const editMsg = `✅ *Đã hoàn thành:* ${safeTitle} (lúc ${formatDisplayDate(new Date().toISOString(), tz)})`;
          await this.telegram.editMessageText(chatId, messageId, editMsg, { parse_mode: 'Markdown' });
        }
      }

      await this.telegram.answerCallbackQuery(query.id, 'Đã ghi nhận hoàn thành!');
      return;
    }

    if (subAction === 'snooze') {
      // Format: action:snooze:{minutes|tomorrow}:{taskId}
      const snoozeArg = paramId;
      const taskId = parts[3];
      const task = await this.taskService.getTaskById(taskId);

      if (!task) {
        await this.telegram.answerCallbackQuery(query.id, 'Công việc không tồn tại!');
        return;
      }

      if (task.user_id !== query.from.id) {
        await this.telegram.answerCallbackQuery(
          query.id,
          'Bạn không có quyền thao tác trên công việc này!',
          true
        );
        return;
      }

      let newRemindAt: string;
      let snoozeNote: string;

      if (snoozeArg === 'tomorrow') {
        newRemindAt = getTomorrowMorningIso(tz, 9, 0);
        snoozeNote = 'đến 09:00 sáng mai';
      } else {
        const mins = parseInt(snoozeArg, 10) || 15;
        newRemindAt = addMinutes(new Date(), mins);
        snoozeNote = `thêm ${mins} phút`;
      }

      await this.taskService.snoozeTask(taskId, newRemindAt);

      if (messageId) {
        const editMsg = `💤 *Đã hoãn nhắc nhở ${snoozeNote}*\n📌 *${escapeMarkdown(task.title)}*\n⏰ Sẽ nhắc lại vào: *${formatDisplayDate(newRemindAt, tz)}*`;
        await this.telegram.editMessageText(chatId, messageId, editMsg, { parse_mode: 'Markdown' });
      }

      await this.telegram.answerCallbackQuery(query.id, `Đã hoãn ${snoozeNote}`);
      return;
    }

    if (subAction === 'resched') {
      // Format: action:resched:{1h|tonight|tomorrow}:{taskId}
      const taskId = parts[3];
      const task = await this.taskService.getTaskById(taskId);

      if (!task) {
        await this.telegram.answerCallbackQuery(query.id, 'Công việc không tồn tại!');
        return;
      }
      if (task.user_id !== query.from.id) {
        await this.telegram.answerCallbackQuery(query.id, 'Bạn không có quyền thao tác trên công việc này!', true);
        return;
      }
      if (task.status !== 'PENDING') {
        await this.telegram.answerCallbackQuery(query.id, 'Công việc đã đóng, không thể đổi giờ.');
        return;
      }

      let newDue: string;
      if (paramId === 'tomorrow') {
        newDue = getTomorrowMorningIso(tz, 9, 0);
      } else if (paramId === 'tonight') {
        const today = getLocalDateParts(new Date(), tz);
        const iso = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}T20:00:00${getTimezoneOffsetString(new Date(), tz)}`;
        newDue = toUtcIso(iso, tz);
        // 20:00 already gone -> next evening
        if (new Date(newDue).getTime() <= Date.now()) newDue = addMinutes(newDue, 24 * 60);
      } else {
        newDue = addMinutes(new Date(), 60);
      }

      await this.taskService.rescheduleTask(taskId, newDue);

      if (messageId) {
        const editMsg = `✏️ *Đã đổi giờ nhắc*\n📌 *${escapeMarkdown(task.title)}*\n⏰ Hạn chót mới: *${formatDisplayDate(newDue, tz)}*`;
        await this.telegram.editMessageText(chatId, messageId, editMsg, {
          parse_mode: 'Markdown',
          reply_markup: createTaskCreatedKeyboard(taskId),
        });
      }
      await this.telegram.answerCallbackQuery(query.id, 'Đã cập nhật giờ!');
      return;
    }

    if (subAction === 'cancel') {
      const taskId = paramId;
      const task = await this.taskService.getTaskById(taskId);

      if (!task) {
        await this.telegram.answerCallbackQuery(query.id, 'Công việc không tồn tại!');
        return;
      }

      if (task.user_id !== query.from.id) {
        await this.telegram.answerCallbackQuery(
          query.id,
          'Bạn không có quyền thao tác trên công việc này!',
          true
        );
        return;
      }

      await this.taskService.cancelTask(taskId);

      if (messageId) {
        const editMsg = `🗑 *Đã hủy nhắc việc:* ~${escapeMarkdown(task.title)}~`;
        await this.telegram.editMessageText(chatId, messageId, editMsg, { parse_mode: 'Markdown' });
      }

      await this.telegram.answerCallbackQuery(query.id, 'Đã hủy công việc!');
      return;
    }

    await this.telegram.answerCallbackQuery(query.id);
  }
}
