import { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from '../types/task';

type InlineRows = TelegramInlineKeyboardMarkup['inline_keyboard'];

// Labels of the persistent bottom menu; the webhook maps them back to commands.
export const MENU_LIST = '📋 Danh sách';
export const MENU_TODAY = '📅 Hôm nay';
export const MENU_HELP = '❓ Hướng dẫn';

export const MENU_COMMANDS: Record<string, string> = {
  [MENU_LIST]: '/list',
  [MENU_TODAY]: '/today',
  [MENU_HELP]: '/help',
};

/**
 * Persistent keyboard shown above the text input.
 */
export function createMainMenuKeyboard(): TelegramReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: MENU_LIST }, { text: MENU_TODAY }], [{ text: MENU_HELP }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'VD: 9h sáng mai họp team',
  };
}

function reschedRows(taskId: string): InlineRows {
  return [
    [
      { text: '⏰ +1 giờ', callback_data: `action:resched:1h:${taskId}` },
      { text: '🌙 Tối nay 20h', callback_data: `action:resched:tonight:${taskId}` },
    ],
    [
      { text: '📅 Mai 9h', callback_data: `action:resched:tomorrow:${taskId}` },
      { text: '📅 Mai 14h', callback_data: `action:resched:tomorrow14:${taskId}` },
    ],
  ];
}

/**
 * Keyboard attached when a new task is created.
 * When the bot had to guess the time, the quick-fix presets are shown right away.
 */
export function createTaskCreatedKeyboard(
  taskId: string,
  timeAssumed = false
): TelegramInlineKeyboardMarkup {
  const actions = [
    { text: '✅ Xong', callback_data: `action:done:${taskId}` },
    { text: '🗑 Hủy', callback_data: `action:cancel:${taskId}` },
  ];
  if (timeAssumed) {
    return { inline_keyboard: [...reschedRows(taskId), actions] };
  }
  return {
    inline_keyboard: [
      [
        { text: '✏️ Sửa giờ', callback_data: `action:edit:${taskId}` },
        ...actions,
      ],
    ],
  };
}

/**
 * Preset times shown after tapping "✏️ Sửa giờ".
 */
export function createReschedKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...reschedRows(taskId),
      [{ text: '⬅️ Quay lại', callback_data: `action:back:${taskId}` }],
    ],
  };
}

/**
 * Shown after Done / Cancel so an accidental tap can be reverted.
 */
export function createUndoKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '↩️ Hoàn tác', callback_data: `action:undo:${taskId}` }]],
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
      [{ text: '✅ Hoàn thành', callback_data: `action:done:${taskId}` }],
      [
        { text: '💤 +15 phút', callback_data: `action:snooze:15:${taskId}` },
        { text: '💤 +1 giờ', callback_data: `action:snooze:60:${taskId}` },
        { text: '📅 Ngày mai 9h', callback_data: `action:snooze:tomorrow:${taskId}` },
      ],
    ],
  };
}

/**
 * Keyboard for the single-message task list: one row per task with its number,
 * a done button and a cancel button. The trailing context (":l" list, ":t" today) tells the callback handler
 * to refresh the list in place instead of replacing the message.
 */
export function createTaskListKeyboard(
  tasks: Array<{ id: string; title: string }>,
  context: 'l' | 't' = 'l'
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: tasks.map((t, i) => {
      const short = t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title;
      return [
        { text: `✅ ${i + 1}. ${short}`, callback_data: `action:done:${t.id}:${context}` },
        { text: '🗑', callback_data: `action:cancel:${t.id}:${context}` },
      ];
    }),
  };
}
