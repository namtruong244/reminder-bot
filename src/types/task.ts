export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type TaskStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';

export interface UserRecord {
  telegram_id: number;
  username?: string | null;
  timezone: string;
  icloud_apple_id?: string | null;
  icloud_app_password_enc?: string | null;
  icloud_calendar_url?: string | null;
  sync_token?: string | null;
  morning_brief_time?: string;
  created_at?: string;
}

export interface TaskRecord {
  id: string; // UUID v4 (used also as CalDAV UID)
  user_id: number;
  title: string;
  description?: string | null;
  due_at: string; // ISO 8601 UTC (e.g. 2026-10-21T08:00:00.000Z)
  remind_at: string; // ISO 8601 UTC
  priority: TaskPriority;
  status: TaskStatus;
  recurrence_rule?: string | null; // iCalendar RRULE (e.g. FREQ=DAILY;INTERVAL=1)
  nagging_mode: number; // 0 or 1
  snooze_count: number;
  caldav_etag?: string | null;
  ios_synced: number; // 0 or 1
  last_notified_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NlpDebugInfo {
  source: 'GEMINI' | 'REGEX_FALLBACK' | 'REGEX_NO_API_KEY';
  model?: string;
  latency_ms?: number;
  apiKeyConfigured?: boolean;
  error?: string;
}

export interface NlpExtractedTask {
  intent: 'CREATE_TASK' | 'LIST_TASKS' | 'CANCEL_TASK' | 'UNKNOWN';
  title?: string | null;
  description?: string | null;
  due_at_iso?: string | null;
  remind_before_minutes?: number | null;
  priority?: TaskPriority | null;
  nagging_mode?: boolean | null;
  recurrence_rrule?: string | null;
  /** True when the message carried no time info and a default due time was substituted. */
  time_assumed?: boolean;
  debug?: NlpDebugInfo;
}

// Telegram Bot Types
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TelegramVoice;
  audio?: TelegramVoice;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
