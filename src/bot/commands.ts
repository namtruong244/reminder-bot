import { Env } from '../types/env';
import { TelegramMessage } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
import { NlpService } from '../services/nlp.service';
import { formatDisplayDate, escapeMarkdown, DEFAULT_TZ } from '../utils/datetime';
import { createTaskListKeyboard } from './keyboards';

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
👋 *Xin chào! Tôi là Trợ lý Nhắc việc Thông minh.*

Tôi giúp bạn quản lý công việc và đồng bộ hai chiều với *Apple Reminders*:
• 💬 Nhắn tự nhiên bằng tiếng Việt (VD: _"Nhắc tôi 3h chiều mai gửi hợp đồng cho khách, việc gấp"_).
• 🔔 Tự động đẩy thông báo nhắc việc đúng giờ trên Telegram.
• 📱 Đồng bộ hai chiều với iPhone qua iOS Shortcuts Bridge.

*Các lệnh nhanh:*
/list - Xem danh sách việc chưa hoàn thành
/today - Xem các việc cần làm hôm nay
/sync - Trạng thái đồng bộ iOS
/help - Xem hướng dẫn đầy đủ
    `.trim();

    await this.telegram.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
  }

  private async handleHelp(chatId: number): Promise<void> {
    const help = `
📖 *HƯỚNG DẪN SỬ DỤNG*

1️⃣ *Tạo nhắc nhở:* Nhắn tin văn bản tự nhiên bằng tiếng Việt:
• _"9h sáng mai họp team marketing"_
• _"Nhắc tôi uống nước sau 30 phút nữa"_
• _"Chiều thứ 6 lúc 17h đón con ở trường, việc gấp"_
• _"Mỗi ngày 8h sáng uống vitamin"_

2️⃣ *Quản lý:*
• /today: Xem việc trong ngày
• /list: Xem 20 việc sắp tới
• /sync: Kiểm tra đồng bộ iOS (ios_synced)
• /timezone <múi_giờ>: Đổi múi giờ (mặc định: \`Asia/Ho_Chi_Minh\`)
• /debug: Kiểm tra trạng thái AI Gemini, API Key và chẩn đoán NLP
• /debug <câu nói>: Chạy thử nghiệm phân tích NLP với trace log chi tiết

3️⃣ *Đồng bộ iOS Reminders (Shortcuts):*
• Các task tạo trên Telegram sẵn sàng kéo về app Lời nhắc của iPhone thông qua Phím tắt (Shortcuts).
• Dùng lệnh /sync để xem số lượng task đang chờ kéo về iPhone (ios_synced = 0) và đã đồng bộ (ios_synced = 1).
    `.trim();
    await this.telegram.sendMessage(chatId, help, { parse_mode: 'Markdown' });
  }

  private async handleList(chatId: number, userId: number): Promise<void> {
    const user = await this.taskService.getUser(userId);
    const timezone = user?.timezone || DEFAULT_TZ;
    const tasks = await this.taskService.getTasksByUser(userId, 'PENDING', 20);

    if (tasks.length === 0) {
      await this.telegram.sendMessage(chatId, '🎉 Bạn không có công việc nào đang chờ xử lý!');
      return;
    }

    await this.telegram.sendMessage(
      chatId,
      `📋 *DANH SÁCH CÔNG VIỆC CHỜ (${tasks.length})*`,
      { parse_mode: 'Markdown' }
    );

    for (const task of tasks) {
      const priorityEmoji =
        task.priority === 'CRITICAL' ? '🔴 [GẤP]' :
        task.priority === 'HIGH' ? '🟠' :
        task.priority === 'LOW' ? '🟢' : '🔵';

      const safeTitle = escapeMarkdown(task.title);
      const safeDesc = task.description ? escapeMarkdown(task.description) : '';
      const syncBadge = task.ios_synced === 1 ? '🍏 iOS: Đã sync' : '⏳ iOS: Chưa sync';

      const text = `
${priorityEmoji} *${safeTitle}*
⏰ Hạn chót: ${formatDisplayDate(task.due_at, timezone)}
🔔 Nhắc tiếp: ${formatDisplayDate(task.remind_at, timezone)}
${task.recurrence_rule ? `🔄 Lặp lại: \`${task.recurrence_rule}\`\n` : ''}${safeDesc ? `📝 ${safeDesc}\n` : ''}📱 ${syncBadge}
      `.trim();

      await this.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: createTaskListKeyboard(task.id),
      });
    }
  }

  private async handleToday(chatId: number, userId: number): Promise<void> {
    const user = await this.taskService.getUser(userId);
    const timezone = user?.timezone || DEFAULT_TZ;
    const tasks = await this.taskService.getTodayTasks(userId, timezone);

    if (tasks.length === 0) {
      await this.telegram.sendMessage(chatId, '☀️ Hôm nay bạn không có công việc nào đến hạn!');
      return;
    }

    let message = `📅 *CÔNG VIỆC HÔM NAY (${tasks.length})*\n\n`;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const p = task.priority === 'CRITICAL' ? '🔥' : '📌';
      const syncStatus = task.ios_synced === 1 ? '🍏' : '⏳';
      message += `${i + 1}. ${p} *${escapeMarkdown(task.title)}* (${formatDisplayDate(task.due_at, timezone)}) [${syncStatus}]\n`;
    }

    await this.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  private async handleSync(chatId: number, userId: number): Promise<void> {
    const userUnsynced = await this.taskService.getUnsyncedIosTasks(100, userId);
    const syncedCount = await this.taskService.getSyncedIosTasksCount(userId);

    const text = `
📱 *TRẠNG THÁI ĐỒNG BỘ iOS REMINDERS (SHORTCUTS)*
• Phương thức: Native Apple Reminders qua iOS Shortcuts Bridge
• Trạng thái cột \`ios_synced\`:
  ⏳ Đang chờ kéo về iPhone (\`ios_synced = 0\`): *${userUnsynced.length}* việc
  ✅ Đã đồng bộ sang iPhone (\`ios_synced = 1\`): *${syncedCount}* việc

🔗 *API Endpoints cho iOS Phím tắt (Shortcuts):*
• Kéo việc chưa đồng bộ: \`GET /api/ios/unsynced\`
• Báo đã đồng bộ: \`POST /api/ios/synced\` (gửi \`task_id\` hoặc \`id\`)
• Đánh dấu hoàn thành từ iOS: \`POST /api/ios/webhook\`

💡 _Mẹo: Mở app Phím tắt (Shortcuts) trên iPhone để chạy automation đồng bộ._
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

    const modelName = this.env.LLM_MODEL || 'gemini-3.8-flash';

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
• API Key: *${hasGeminiKey ? `✅ Đã cấu hình (\`${maskedKey}\`, độ dài: ${geminiKeyLen})` : `❌ CHƯA CẤU HÌNH / BỊ RỖNG!`}*
• Model: \`${escapeMarkdown(modelName)}\`
${!hasGeminiKey ? `⚠️ *LƯU Ý:* Vì thiếu GEMINI_API_KEY, bot đang tự động fallback về Regex parser thuần túy! Cần chạy lệnh \`wrangler secret put GEMINI_API_KEY\` trên Cloudflare.\n` : ''}
🤖 *Telegram Bot:*
• Bot Token: *${this.env.TELEGRAM_BOT_TOKEN ? '✅ Đã cấu hình' : '❌ Thiếu'}*
• Webhook Secret: *${this.env.TELEGRAM_WEBHOOK_SECRET ? '✅ Đã cấu hình' : '⚪ Không bắt buộc'}*

🗄 *Cloudflare D1 Database:*
• Trạng thái: *${dbStatus}*
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
          ? 'Regex Parser (Do GEMINI_API_KEY chưa cấu hình)'
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
