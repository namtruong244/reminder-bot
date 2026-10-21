import { TelegramInlineKeyboardMarkup } from '../types/task';

/**
 * Keyboard attached when a new task is created.
 */
export function createTaskCreatedKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Hoàn thành ngay', callback_data: `action:done:${taskId}` },
        { text: '🗑 Hủy nhắc nhở', callback_data: `action:cancel:${taskId}` },
      ],
    ],
  };
}

/**
 * Keyboard attached when a scheduled reminder is sent.
 * Row 1: [✅ Hoàn thành]
 * Row 2: [💤 +15 phút] [💤 +1 giờ] [📅 Ngày mai 9h]
 */
export function createReminderKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Hoàn thành', callback_data: `action:done:${taskId}` },
      ],
      [
        { text: '💤 +15 phút', callback_data: `action:snooze:15:${taskId}` },
        { text: '💤 +1 giờ', callback_data: `action:snooze:60:${taskId}` },
        { text: '📅 Ngày mai 9h', callback_data: `action:snooze:tomorrow:${taskId}` },
      ],
    ],
  };
}

/**
 * Keyboard for interactive task list item.
 */
export function createTaskListKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Xong', callback_data: `action:done:${taskId}` },
        { text: '💤 +15p', callback_data: `action:snooze:15:${taskId}` },
        { text: '🗑 Hủy', callback_data: `action:cancel:${taskId}` },
      ],
    ],
  };
}
