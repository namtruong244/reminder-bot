import { Env } from '../types/env';
import { TelegramMessage } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
import { encryptText } from '../utils/crypto';
import { formatDisplayDate, DEFAULT_TZ } from '../utils/datetime';
import { createTaskListKeyboard } from './keyboards';

export class BotCommands {
  constructor(
    private env: Env,
    private telegram: TelegramApi,
    private taskService: TaskService
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
      case '/setup_icloud':
        await this.handleSetupICloud(chatId, userId, args);
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

Tôi giúp bạn quản lý công việc và đồng bộ với *Apple Reminders / Calendar*:
• 💬 Nhắn tự nhiên bằng tiếng Việt (VD: _"Nhắc tôi 3h chiều mai gửi hợp đồng cho khách, việc gấp"_).
• 🔔 Tự động đẩy thông báo nhắc việc đúng giờ trên Telegram.
• 📱 Đồng bộ hai chiều với iPhone (iCloud CalDAV hoặc Shortcuts).

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

1️⃣ *Tạo nhắc nhở:* Bạn có thể nhắn tin thoại hoặc tin nhắn văn bản tự nhiên:
• _"9h sáng mai họp team marketing"_
• _"Nhắc tôi uống nước sau 30 phút nữa"_
• _"Chiều thứ 6 lúc 17h đón con ở trường, việc gấp"_
• _"Mỗi ngày 8h sáng uống vitamin"_

2️⃣ *Quản lý:*
• /today: Xem việc trong ngày
• /list: Xem 20 việc sắp tới
• /sync: Kiểm tra đồng bộ iOS
• /timezone <múi_giờ>: Đổi múi giờ (mặc định: \`Asia/Ho_Chi_Minh\`)

3️⃣ *Cấu hình iCloud Reminders:*
• Dùng lệnh: \`/setup_icloud <Apple_ID> <Mật_khẩu_ứng_dụng> <URL_CalDAV>\`
• Mật khẩu được mã hóa an toàn bằng chuẩn AES-256-GCM.
    `.trim();

    await this.telegram.sendMessage(chatId, help, { parse_mode: 'Markdown' });
  }

  private async handleList(chatId: number, userId: number): Promise<void> {
    const user = await this.taskService.getUser(userId);
    const timezone = user?.timezone || DEFAULT_TZ;
    const tasks = await this.taskService.getTasksByUser(userId, 'PENDING', 10);

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

      const text = `
${priorityEmoji} *${task.title}*
⏰ Hạn chót: ${formatDisplayDate(task.due_at, timezone)}
🔔 Nhắc tiếp: ${formatDisplayDate(task.remind_at, timezone)}
${task.recurrence_rule ? `🔄 Lặp lại: \`${task.recurrence_rule}\`` : ''}
${task.description ? `📝 ${task.description}` : ''}
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
      message += `${i + 1}. ${p} *${task.title}* (${formatDisplayDate(task.due_at, timezone)})\n`;
    }

    await this.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  private async handleSync(chatId: number, userId: number): Promise<void> {
    const user = await this.taskService.getUser(userId);
    const hasICloud = !!(user?.icloud_apple_id && user.icloud_app_password_enc);
    const unsynced = await this.taskService.getUnsyncedIosTasks();
    const userUnsynced = unsynced.filter((t) => t.user_id === userId);

    const text = `
📱 *TRẠNG THÁI ĐỒNG BỘ iOS*
• iCloud CalDAV Direct: ${hasICloud ? '✅ Đã cấu hình' : '❌ Chưa cấu hình (/setup_icloud)'}
• Apple ID: ${user?.icloud_apple_id ? `\`${user.icloud_apple_id}\`` : 'Chưa có'}
• Số task chờ đồng bộ iOS: *${userUnsynced.length}*
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
        `✅ Đã cập nhật múi giờ của bạn thành: \`${timezone}\``,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await this.telegram.sendMessage(
        chatId,
        `❌ Múi giờ không hợp lệ (\`${timezone}\`). Vui lòng dùng định dạng chuẩn IANA (VD: \`Asia/Ho_Chi_Minh\`, \`Asia/Tokyo\`).`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  private async handleSetupICloud(chatId: number, userId: number, args: string[]): Promise<void> {
    if (args.length < 3) {
      const syntax = `
⚠️ *Cú pháp cấu hình iCloud:*
\`/setup_icloud <Apple_ID> <App_Specific_Password> <CalDAV_URL>\`

Ví dụ:
\`/setup_icloud user@icloud.com abcd-efgh-ijkl-mnop https://caldav.icloud.com/...\`

*Lưu ý an toàn:* Hãy tạo Mật khẩu Dành riêng cho Ứng dụng (App-Specific Password) tại appleid.apple.com, không dùng mật khẩu chính của tài khoản Apple. Mật khẩu sẽ được mã hóa AES-256-GCM.
      `.trim();
      await this.telegram.sendMessage(chatId, syntax, { parse_mode: 'Markdown' });
      return;
    }

    const [appleId, appPassword, calendarUrl] = args;
    const secretKey = this.env.ENCRYPTION_SECRET_KEY || 'default-fallback-32-byte-secret-key-32';

    try {
      const encryptedPassword = await encryptText(appPassword, secretKey);
      await this.taskService.updateUserICloud(userId, appleId, encryptedPassword, calendarUrl);

      await this.telegram.sendMessage(
        chatId,
        `✅ *Đã lưu thông tin kết nối iCloud CalDAV thành công!*
Mật khẩu đã được mã hóa an toàn và sẵn sàng đồng bộ 2 chiều với Apple Reminders.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Error saving iCloud config:', err);
      await this.telegram.sendMessage(chatId, '❌ Lỗi khi mã hóa và lưu thông tin iCloud.');
    }
  }
}
