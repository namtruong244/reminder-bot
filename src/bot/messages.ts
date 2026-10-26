import { TaskRecord, TelegramInlineKeyboardMarkup, TaskPriority } from '../types/task';
import { createTaskListKeyboard } from './keyboards';
import {
  describeRecurrence,
  escapeMarkdown,
  formatCountdown,
  formatDayLabel,
  formatFriendlyDate,
  formatTimeOnly,
  DEFAULT_TZ,
} from '../utils/datetime';

// Telegram caps inline keyboards and messages; 10 rows keeps lists readable on a phone.
export const LIST_PAGE_SIZE = 10;

export function priorityLabel(priority: TaskPriority): string {
  switch (priority) {
    case 'CRITICAL':
      return '🔴 Khẩn cấp';
    case 'HIGH':
      return '🟠 Cao';
    case 'LOW':
      return '🟢 Thấp';
    default:
      return '🔵 Bình thường';
  }
}

const priorityDot = (p: TaskPriority) =>
  p === 'CRITICAL' ? '🔴' : p === 'HIGH' ? '🟠' : p === 'LOW' ? '🟢' : '🔹';

type CardTask = Pick<
  TaskRecord,
  'title' | 'description' | 'due_at' | 'remind_at' | 'priority' | 'nagging_mode' | 'recurrence_rule'
>;

/**
 * One task as a compact card:
 *   📌 *Gửi hợp đồng*
 *   ⏰ Ngày mai 15:00 · còn 31 giờ
 *   🔔 Nhắc trước lúc Ngày mai 14:45
 *   🔴 Khẩn cấp · 🔁 nhắc lại mỗi 10 phút
 */
export function renderTaskCard(
  task: CardTask,
  tz: string = DEFAULT_TZ,
  now: Date = new Date()
): string {
  const lines = [`📌 *${escapeMarkdown(task.title)}*`];
  lines.push(`⏰ ${formatFriendlyDate(task.due_at, tz, now)} · ${formatCountdown(task.due_at, now)}`);

  const remindMs = new Date(task.remind_at).getTime();
  const dueMs = new Date(task.due_at).getTime();
  if (remindMs < dueMs - 60_000 && remindMs > now.getTime()) {
    const when = formatFriendlyDate(task.remind_at, tz, now);
    lines.push(`🔔 Nhắc trước lúc ${when.charAt(0).toLowerCase()}${when.slice(1)}`);
  }

  const flags: string[] = [];
  if (task.priority !== 'MEDIUM') flags.push(priorityLabel(task.priority));
  if (task.nagging_mode === 1) flags.push('🔁 nhắc lại mỗi 10 phút');
  if (flags.length > 0) lines.push(flags.join(' · '));

  if (task.recurrence_rule) lines.push(`🔄 ${escapeMarkdown(describeRecurrence(task.recurrence_rule))}`);
  if (task.description) lines.push(`📝 ${escapeMarkdown(task.description)}`);
  return lines.join('\n');
}

/**
 * Confirmation after a task is created.
 */
export function renderCreatedMessage(
  task: CardTask,
  tz: string,
  opts: { timeAssumed?: boolean; aiFallback?: boolean } = {},
  now: Date = new Date()
): string {
  let text = `✅ *Đã tạo nhắc nhở*\n\n${renderTaskCard(task, tz, now)}`;
  if (opts.timeAssumed) {
    text += `\n\n❓ _Bạn chưa nói rõ giờ nên mình tạm đặt sau 30 phút. Chọn giờ khác bên dưới nhé._`;
  }
  if (opts.aiFallback) {
    text += `\n\n⚠️ _AI đang bận nên mình dùng bộ phân tích dự phòng, bạn kiểm tra lại giờ giúp mình nhé._`;
  }
  return text;
}

/**
 * Single-message task list grouped by day, with a matching inline keyboard.
 * `grouped: false` renders a flat list (used for "Hôm nay", where every item shares the day).
 */
export function renderTaskList(
  tasks: TaskRecord[],
  tz: string,
  opts: { heading: string; grouped?: boolean; context?: 'l' | 't' },
  now: Date = new Date()
): { text: string; keyboard: TelegramInlineKeyboardMarkup } {
  const shown = tasks.slice(0, LIST_PAGE_SIZE);
  const grouped = opts.grouped !== false;
  const lines: string[] = [`${opts.heading} (${tasks.length})`];

  let currentGroup = '';
  shown.forEach((t, i) => {
    if (grouped) {
      const overdue = new Date(t.due_at).getTime() < now.getTime() - 60_000;
      const group = overdue ? '⚠️ Quá hạn' : formatDayLabel(t.due_at, tz, now);
      if (group !== currentGroup) {
        lines.push('', `*${group}*`);
        currentGroup = group;
      }
    } else if (i === 0) {
      lines.push('');
    }

    const time = formatTimeOnly(t.due_at, tz);
    const repeat = t.recurrence_rule ? ' 🔄' : '';
    const nag = t.nagging_mode === 1 ? ' 🔁' : '';
    lines.push(`${i + 1}. ${priorityDot(t.priority)} ${time} · ${escapeMarkdown(t.title)}${repeat}${nag}`);
  });

  if (tasks.length > shown.length) {
    lines.push('', `_…và ${tasks.length - shown.length} việc khác_`);
  }
  lines.push('', '_Bấm ✅ để hoàn thành, 🗑 để hủy._');

  return {
    text: lines.join('\n'),
    keyboard: createTaskListKeyboard(shown, opts.context ?? 'l'),
  };
}

export const EMPTY_LIST_TEXT =
  '🎉 *Không còn việc nào đang chờ!*\n\nNhắn cho mình nội dung để tạo nhắc nhở mới, ví dụ:\n_"9h sáng mai họp team"_';

export const EMPTY_TODAY_TEXT =
  '☀️ *Hôm nay bạn rảnh!*\n\nKhông có việc nào đến hạn. Cần nhắc gì thì cứ nhắn cho mình nhé.';

/**
 * Message sent by the cron when a reminder is due.
 */
export function renderReminderMessage(
  task: CardTask & { snooze_count: number },
  tz: string,
  now: Date = new Date()
): string {
  const early = new Date(task.remind_at).getTime() < new Date(task.due_at).getTime() - 60_000;
  const urgent = task.priority === 'CRITICAL' || task.nagging_mode === 1;

  const header = urgent
    ? '🚨 *KHẨN CẤP — ĐẾN GIỜ RỒI!*'
    : early
    ? `⏳ *Sắp đến hạn* (${formatCountdown(task.due_at, now)})`
    : '🔔 *Đến giờ rồi!*';

  let text = `${header}\n\n📌 *${escapeMarkdown(task.title)}*\n⏰ ${formatFriendlyDate(task.due_at, tz, now)}`;
  if (task.description) text += `\n📝 ${escapeMarkdown(task.description)}`;
  if (task.snooze_count > 0) text += `\n💤 Đã hoãn ${task.snooze_count} lần`;
  if (task.nagging_mode === 1) text += `\n\n_🔁 Mình sẽ nhắc lại mỗi 10 phút cho đến khi bạn bấm Hoàn thành._`;
  return text;
}
