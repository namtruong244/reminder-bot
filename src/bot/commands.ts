import { Env } from '../types/env';
import { TelegramMessage } from '../types/task';
import { TelegramApi } from './telegram';
import { TaskService } from '../services/task.service';
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

3️⃣ *Đồng bộ iOS Reminders:*
• Các task tạo trên Telegram sẽ tự động sẵn sàng để đồng bộ về app Lời nhắc của iPhone thông qua Phím tắt (Shortcuts).
• Dùng lệnh /sync để xem số lượng task đang chờ kéo về iPhone.
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
📱 *TRẠNG THÁI ĐỒNG BỘ iOS REMINDERS*
• Phương thức: iOS Shortcuts REST Bridge (Native Apple Reminders)
• Số task đang chờ đồng bộ về iPhone: *${userUnsynced.length}*

💡 _Mẹo: Mở app Lời nhắc trên iPhone để Phím tắt tự động kéo task về._
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

}
