import { Env } from '../types/env';
import { TelegramApi } from '../bot/telegram';
import { TaskService } from './task.service';
import { createReminderKeyboard } from '../bot/keyboards';
import {
  formatDisplayDate,
  addMinutes,
  escapeMarkdown,
  getLocalDateParts,
  DEFAULT_TZ,
} from '../utils/datetime';

export class NotifierService {
  private telegram: TelegramApi;
  private taskService: TaskService;

  constructor(private env: Env) {
    this.telegram = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    this.taskService = new TaskService(env.DB);
  }

  /**
   * Main cron job executed every minute to scan pending tasks and notify users.
   */
  async processDueTasks(): Promise<number> {
    const dueTasks = await this.taskService.getPendingTasksDue(50);
    if (dueTasks.length === 0) return 0;

    const now = new Date();
    const nowUtcIso = now.toISOString();
    const updatesToBatch: Array<{ id: string; remind_at: string; last_notified_at?: string }> = [];

    const deliveryResults = await Promise.allSettled(
      dueTasks.map(async (task) => {
        const tz = task.timezone || DEFAULT_TZ;
        const isCritical = task.priority === 'CRITICAL' || task.nagging_mode === 1;

        const titleHeader = isCritical
          ? '🔔 NHẮC VIỆC [KHẨN CẤP]'
          : '🔔 NHẮC NHỞ CÔNG VIỆC';

        const safeTitle = escapeMarkdown(task.title);
        let message = `
${titleHeader}
📌 Nội dung: *${safeTitle}*
⏰ Hạn chót: *${formatDisplayDate(task.due_at, tz)}*
        `.trim();

        if (task.description) {
          message += `\n📝 Ghi chú: ${escapeMarkdown(task.description)}`;
        }

        if (task.snooze_count > 0) {
          message += `\n💤 Đã hoãn: ${task.snooze_count} lần`;
        }

        const sent = await this.telegram.sendMessage(task.user_id, message, {
          parse_mode: 'Markdown',
          reply_markup: createReminderKeyboard(task.id),
        });

        return { task, sent: !!sent };
      })
    );

    for (const res of deliveryResults) {
      if (res.status !== 'fulfilled' || !res.value.sent) {
        if (res.status === 'fulfilled') {
          console.warn(
            `Failed to deliver notification to user ${res.value.task.user_id} for task ${res.value.task.id}`
          );
        }
        continue;
      }

      const { task } = res.value;
      let nextRemindAt: string;
      const dueDate = new Date(task.due_at);

      if (task.nagging_mode === 1) {
        // Nagging mode: repeat every 10 minutes until user marks Done
        nextRemindAt = addMinutes(now, 10);
      } else if (new Date(task.remind_at).getTime() < dueDate.getTime()) {
        // Reminded before due time; next reminder is exactly at due time
        nextRemindAt = task.due_at;
      } else {
        // Already reminded at/after due time: postpone far away to avoid re-triggering
        nextRemindAt = '9999-12-31T23:59:59.000Z';
      }

      updatesToBatch.push({
        id: task.id,
        remind_at: nextRemindAt,
        last_notified_at: nowUtcIso,
      });
    }

    // Batch update all updated tasks in one D1 call
    if (updatesToBatch.length > 0) {
      await this.taskService.batchUpdateRemindAt(updatesToBatch);
    }

    return updatesToBatch.length;
  }

  /**
   * Sends morning briefing to users who have tasks scheduled for today.
   * Respects user's timezone and morning_brief_time setting when applicable.
   */
  async processMorningBriefing(enforceUserBriefTime = false): Promise<void> {
    const query = `
      SELECT DISTINCT
        t.user_id,
        COALESCE(u.timezone, 'Asia/Ho_Chi_Minh') as timezone,
        COALESCE(u.morning_brief_time, '08:00') as morning_brief_time
      FROM tasks t
      JOIN users u ON t.user_id = u.telegram_id
      WHERE t.status = 'PENDING';
    `;
    const { results } = await this.env.DB.prepare(query).all<{
      user_id: number;
      timezone: string;
      morning_brief_time: string;
    }>();
    if (!results || results.length === 0) return;

    const now = new Date();

    await Promise.allSettled(
      results.map(async (row) => {
        if (enforceUserBriefTime) {
          const localParts = getLocalDateParts(now, row.timezone);
          const currentHm = `${localParts.hour.toString().padStart(2, '0')}:${localParts.minute
            .toString()
            .padStart(2, '0')}`;
          if (currentHm !== row.morning_brief_time) {
            return;
          }
        }

        const todayTasks = await this.taskService.getTodayTasks(row.user_id, row.timezone);
        if (todayTasks.length === 0) return;

        let brief = `☀️ *CHÀO BUỔI SÁNG! BẢN TIN CÔNG VIỆC HÔM NAY*\n\n`;
        brief += `Hôm nay bạn có *${todayTasks.length}* công việc cần thực hiện:\n`;

        for (let i = 0; i < todayTasks.length; i++) {
          const t = todayTasks[i];
          const icon = t.priority === 'CRITICAL' ? '🔴 [GẤP]' : '📌';
          brief += `${i + 1}. ${icon} *${escapeMarkdown(t.title)}* (${formatDisplayDate(
            t.due_at,
            row.timezone
          )})\n`;
        }

        brief += `\nChúc bạn một ngày làm việc hiệu quả! Gõ /today hoặc /list để tương tác.`;

        await this.telegram.sendMessage(row.user_id, brief, { parse_mode: 'Markdown' });
      })
    );
  }
}
