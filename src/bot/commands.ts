import { Env } from '../types/env';
import { TelegramMessage } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
import { NlpService } from '../services/nlp.service';
import { formatDisplayDate, escapeMarkdown, DEFAULT_TZ } from '../utils/datetime';
import { createMainMenuKeyboard } from './keyboards';
import { renderTaskList, EMPTY_LIST_TEXT, EMPTY_TODAY_TEXT } from './messages';
import { TelegramInlineKeyboardMarkup } from '../types/task';

export class BotCommands {
  constructor(
    private env: Env,
    private telegram: TelegramApi,
    private taskService: TaskService,
    private nlpService?: NlpService
  ) {}

  async handleCommand(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim() || '';
    const chatId = message.chat.id;
    const userId = message.from?.id || chatId;
    const username = message.from?.username || null;

    // Ensure user exists in database
    await this.taskService.upsertUser({
      telegram_id: userId,
      username,
    });

    const [cmd, ...args] = text.split(/\s+/);
    const commandName = cmd.toLowerCase().replace(/@.+$/, ''); // Remove bot username mention e.g. /start@bot

    switch (commandName) {
      case '/start':
        await this.handleStart(chatId);
        break;
      case '/help':
        await this.handleHelp(chatId);
        break;
      case '/list':
        await this.handleList(chatId, userId);
        break;
      case '/today':
        await this.handleToday(chatId, userId);
        break;
      case '/sync':
        await this.handleSync(chatId, userId);
        break;
      case '/timezone':
        await this.handleTimezone(chatId, userId, args.join(' '));
        break;
      case '/debug':
        await this.handleDebug(chatId, userId, args.join(' '));
        break;
      default:
        await this.telegram.sendMessage(
          chatId,
          `❓ Lệnh không hợp lệ. Gõ /help để xem hướng dẫn chi tiết.`
        );
        break;
    }
  }

  private async handleStart(chatId: number): Promise<void> {
    const welcome = `
👋 *Chào bạn! Mình là trợ lý nhắc việc.*

Cứ nhắn tự nhiên bằng tiếng Việt, mình sẽ hiểu và nhắc đúng giờ:
• _"3h chiều mai gửi hợp đồng, việc gấp"_
• _"30 phút nữa tắt bếp"_
• _"Thứ 2 và thứ 4 hàng tuần đi gym 6h sáng"_

Đến giờ mình nhắn bạn kèm nút ✅ Hoàn thành hoặc 💤 Hoãn. Việc đã tạo cũng được đồng bộ sang app Lời nhắc trên iPhone.

Dùng menu bên dưới để xem việc nhanh 👇
    `.trim();

    await this.telegram.sendMessage(chatId, welcome, {
      parse_mode: 'Markdown',
      reply_markup: createMainMenuKeyboard(),
    });
  }

  private async handleHelp(chatId: number): Promise<void> {
    const help = `
📖 *HƯỚNG DẪN*

*Tạo nhắc nhở* — chỉ cần nhắn như nói chuyện:
• _"9h sáng mai họp team marketing"_
• _"Nhắc tôi uống nước sau 30 phút nữa"_
• _"Chiều thứ 6 lúc 17h đón con, việc gấp"_
• _"Ngày 5 hàng tháng đóng tiền nhà"_

💡 Nói "việc gấp" để mình nhắc lại mỗi 10 phút đến khi bạn bấm Hoàn thành. Không nói giờ thì mình sẽ hỏi lại bằng nút chọn nhanh.

*Lệnh*
/list — việc đang chờ
/today — việc hôm nay
/sync — trạng thái đồng bộ iPhone
/timezone — đổi múi giờ (VD: \`/timezone Asia/Tokyo\`)
/debug — kiểm tra bot và thử phân tích câu
    `.trim();
    await this.telegram.sendMessage(chatId, help, {
      parse_mode: 'Markdown',
      reply_markup: createMainMenuKeyboard(),
    });
  }

  /**
   * Builds the single-message list (or the friendly empty state) for /list and /today.
   * Also used by the webhook to refresh the list in place after Done/Cancel.
   */
  async renderListView(
    userId: number,
    context: 'l' | 't'
  ): Promise<{ text: string; keyboard?: TelegramInlineKeyboardMarkup }> {
    const user = await this.taskService.getUser(userId);
    const timezone = user?.timezone || DEFAULT_TZ;

    if (context === 't') {
      const tasks = await this.taskService.getTodayTasks(userId, timezone);
      if (tasks.length === 0) return { text: EMPTY_TODAY_TEXT };
      const view = renderTaskList(tasks, timezone, {
        heading: '📅 *Việc hôm nay*',
        grouped: false,
        context: 't',
      });
      return { text: view.text, keyboard: view.keyboard };
    }

    const tasks = await this.taskService.getTasksByUser(userId, 'PENDING', 50);
    if (tasks.length === 0) return { text: EMPTY_LIST_TEXT };
    const view = renderTaskList(tasks, timezone, { heading: '📋 *Việc đang chờ*', context: 'l' });
    return { text: view.text, keyboard: view.keyboard };
  }

  private async handleList(chatId: number, userId: number): Promise<void> {
    const view = await this.renderListView(userId, 'l');
    await this.telegram.sendMessage(chatId, view.text, {
      parse_mode: 'Markdown',
      reply_markup: view.keyboard,
    });
  }

  private async handleToday(chatId: number, userId: number): Promise<void> {
    const view = await this.renderListView(userId, 't');
    await this.telegram.sendMessage(chatId, view.text, {
      parse_mode: 'Markdown',
      reply_markup: view.keyboard,
    });
  }

  private async handleSync(chatId: number, userId: number): Promise<void> {
    const userUnsynced = await this.taskService.getUnsyncedIosTasks(100, userId);
    const syncedCount = await this.taskService.getSyncedIosTasksCount(userId);

    const text = `
📱 *Đồng bộ iPhone*

⏳ Chờ kéo về iPhone: *${userUnsynced.length}* việc
✅ Đã có trên iPhone: *${syncedCount}* việc

Mở app *Phím tắt (Shortcuts)* trên iPhone và chạy automation để kéo các việc đang chờ vào app Lời nhắc.

*Dành cho Shortcut* (gửi kèm header \`Authorization: Bearer …\`)
• \`GET /api/ios/unsynced\` — việc chờ đồng bộ
• \`POST /api/ios/synced\` — báo đã đồng bộ (\`task_id\`)
• \`GET /api/ios/closed\`, \`POST /api/ios/closed\` — việc đã xong/hủy cần đóng trên iPhone
• \`POST /api/ios/webhook\` — báo hoàn thành từ iPhone
    `.trim();

    await this.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  private async handleTimezone(chatId: number, userId: number, tz: string): Promise<void> {
    const timezone = tz.trim();
    if (!timezone) {
      await this.telegram.sendMessage(
        chatId,
        'Vui lòng nhập múi giờ hợp lệ. Ví dụ:\n`/timezone Asia/Ho_Chi_Minh`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      // Validate timezone
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      await this.taskService.updateUserTimezone(userId, timezone);
      await this.telegram.sendMessage(
        chatId,
        `✅ Đã cập nhật múi giờ của bạn thành: \`${escapeMarkdown(timezone)}\``,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await this.telegram.sendMessage(
        chatId,
        `❌ Múi giờ không hợp lệ (\`${escapeMarkdown(timezone)}\`). Vui lòng dùng định dạng chuẩn IANA (VD: \`Asia/Ho_Chi_Minh\`, \`Asia/Tokyo\`).`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  private async handleDebug(chatId: number, userId: number, queryText: string): Promise<void> {
    const user = await this.taskService.getUser(userId);
    const timezone = user?.timezone || DEFAULT_TZ;

    // Check Gemini API key status
    const geminiKey = this.env.GEMINI_API_KEY?.trim();
    const hasGeminiKey = !!geminiKey && geminiKey.length > 0;
    const geminiKeyLen = geminiKey ? geminiKey.length : 0;
    const maskedKey = hasGeminiKey
      ? `${geminiKey.substring(0, 6)}...${geminiKey.substring(geminiKeyLen - 4)}`
      : 'CHƯA CẤU HÌNH (RỖNG)';

    const modelName = this.env.LLM_MODEL || 'gemini-3.1-flash-lite';

    // If no query text provided, show environment diagnostics
    if (!queryText || queryText.trim().length === 0) {
      let dbStatus = 'Đang kiểm tra...';
      let userCount = 0;
      let taskCount = 0;

      try {
        const uRes = await this.env.DB.prepare('SELECT count(*) as count FROM users;').first<{ count: number }>();
        const tRes = await this.env.DB.prepare('SELECT count(*) as count FROM tasks;').first<{ count: number }>();
        userCount = uRes?.count ?? 0;
        taskCount = tRes?.count ?? 0;
        dbStatus = 'Hoạt động tốt ✅';
      } catch (err) {
        dbStatus = `Lỗi kết nối D1: ${err instanceof Error ? err.message : String(err)}`;
      }

      const report = `
🛠 *BẢNG THÔNG TIN DEBUG HỆ THỐNG*

🔑 *Google Gemini AI:*
• API Key: ${hasGeminiKey ? `✅ Đã cấu hình (\`${maskedKey}\`, độ dài: ${geminiKeyLen})` : '❌ *CHƯA CẤU HÌNH / BỊ RỖNG!*'}
• Model: \`${escapeMarkdown(modelName)}\`
${!hasGeminiKey ? `⚠️ *LƯU Ý:* Vì thiếu GEMINI\\_API\\_KEY, bot đang tự động fallback về Regex parser thuần túy! Cần chạy lệnh \`wrangler secret put GEMINI_API_KEY\` trên Cloudflare.\n` : ''}
🤖 *Telegram Bot:*
• Bot Token: *${this.env.TELEGRAM_BOT_TOKEN ? '✅ Đã cấu hình' : '❌ Thiếu'}*
• Webhook Secret: *${this.env.TELEGRAM_WEBHOOK_SECRET ? '✅ Đã cấu hình' : '⚪ Không bắt buộc'}*

🗄 *Cloudflare D1 Database:*
• Trạng thái: *${escapeMarkdown(dbStatus)}*
• Tổng người dùng: \`${userCount}\`
• Tổng công việc: \`${taskCount}\`
• Múi giờ của bạn: \`${escapeMarkdown(timezone)}\`

💡 *Thử nghiệm phân tích câu nói NLP:*
Gõ lệnh theo cú pháp:
\`/debug <câu nói>\`
Ví dụ:
• \`/debug 3h chiều mai họp giao ban việc gấp\`
• \`/debug nhắc tôi uống nước sau 15p nữa\`
      `.trim();

      await this.telegram.sendMessage(chatId, report, { parse_mode: 'Markdown' });
      return;
    }

    // If query text provided, perform full NLP execution trace
    await this.telegram.sendMessage(
      chatId,
      `⏳ *Đang gửi câu nói tới Gemini AI để phân tích...*\n📝 _"${escapeMarkdown(queryText)}"_`,
      { parse_mode: 'Markdown' }
    );

    if (!this.nlpService) {
      await this.telegram.sendMessage(
        chatId,
        '❌ NlpService chưa được khởi tạo trong BotCommands.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      const trace = await this.nlpService.parseWithDetailedTrace(queryText, timezone);

      let attemptsSummary = '';
      if (trace.attempts.length === 0) {
        attemptsSummary = '⚪ Không có request nào được gửi đến Gemini (do chưa có API Key).';
      } else {
        trace.attempts.forEach((att, idx) => {
          const statusIcon = att.status === 200 ? '✅' : '❌';
          attemptsSummary += `\n*Lần gọi ${idx + 1} (${att.model}):* ${statusIcon} HTTP ${att.status} (${att.durationMs}ms)`;
          if (att.error) {
            attemptsSummary += `\n• Lỗi: \`${escapeMarkdown(att.error.slice(0, 150))}\``;
          }
        });
      }

      const sourceIcon = trace.source === 'GEMINI' ? '🤖' : '⚠️';
      const sourceName =
        trace.source === 'GEMINI'
          ? `Google Gemini AI (${trace.result.debug?.model || modelName})`
          : trace.source === 'REGEX_NO_API_KEY'
          ? 'Regex Parser (Do GEMINI\\_API\\_KEY chưa cấu hình)'
          : 'Regex Parser Dự Phòng (Do Gemini gọi lỗi)';

      const res = trace.result;
      const traceReport = `
🔍 *KẾT QUẢ DEBUG PHÂN TÍCH NLP*

📝 Câu kiểm tra: _"${escapeMarkdown(queryText)}"_
${sourceIcon} *Nguồn xử lý cuối:* *${sourceName}*

📡 *Chi tiết các cuộc gọi API:*
${attemptsSummary}

📊 *Thực thể bóc tách được:*
• *Ý định (Intent):* \`${res.intent}\`
• *Tiêu đề (Title):* ${res.title ? `*${escapeMarkdown(res.title)}*` : '_null_'}
• *Hạn chót (Due at):* \`${res.due_at_iso || 'null'}\`
• *Nhắc trước:* \`${res.remind_before_minutes ?? 0} phút\`
• *Mức độ ưu tiên:* \`${res.priority || 'MEDIUM'}\`
• *Nhắc liên tục (Nagging):* \`${res.nagging_mode ? 'BẬT (10p/lần)' : 'TẮT'}\`
• *Lặp lại (RRULE):* \`${res.recurrence_rrule || 'null'}\`

📄 *Payload JSON:*
\`\`\`json
${escapeMarkdown(JSON.stringify(res, null, 2))}
\`\`\`
      `.trim();

      await this.telegram.sendMessage(chatId, traceReport, { parse_mode: 'Markdown' });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.telegram.sendMessage(
        chatId,
        `❌ *Lỗi trong quá trình chạy debug:* \`${escapeMarkdown(errorMsg)}\``,
        { parse_mode: 'Markdown' }
      );
    }
  }
}
