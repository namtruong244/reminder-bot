import {
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
} from '../types/task';

export class TelegramApi {
  private baseUrl: string;

  constructor(private token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options?: {
      parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      reply_markup?: TelegramInlineKeyboardMarkup;
      reply_to_message_id?: number;
    }
  ): Promise<TelegramMessage | null> {
    try {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: options?.parse_mode,
          reply_markup: options?.reply_markup,
          reply_to_message_id: options?.reply_to_message_id,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`Telegram sendMessage failed (${res.status}): ${errorText}`);

        // Fallback: if Markdown parsing failed (HTTP 400), retry once as plain text
        if (res.status === 400 && options?.parse_mode) {
          const retryRes = await fetch(`${this.baseUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              reply_markup: options?.reply_markup,
              reply_to_message_id: options?.reply_to_message_id,
            }),
          });
          if (retryRes.ok) {
            const retryData = (await retryRes.json()) as { ok: boolean; result: TelegramMessage };
            return retryData.result;
          }
        }
        return null;
      }

      const data = (await res.json()) as { ok: boolean; result: TelegramMessage };
      return data.result;
    } catch (err) {
      console.error('Error sending Telegram message:', err);
      return null;
    }
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options?: {
      parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      reply_markup?: TelegramInlineKeyboardMarkup;
    }
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: options?.parse_mode,
          reply_markup: options?.reply_markup,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Telegram editMessageText failed: ${err}`);

        if (res.status === 400 && options?.parse_mode) {
          const retryRes = await fetch(`${this.baseUrl}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              text,
              reply_markup: options?.reply_markup,
            }),
          });
          return retryRes.ok;
        }
        return false;
      }
      return true;
    } catch (err) {
      console.error('Error editing Telegram message text:', err);
      return false;
    }
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert,
        }),
      });
      return res.ok;
    } catch (err) {
      console.error('Error answering callback query:', err);
      return false;
    }
  }

  async sendChatAction(chatId: number | string, action: 'typing' = 'typing'): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async setWebhook(
    url: string,
    secretToken?: string
  ): Promise<{ success: boolean; description?: string; error_code?: number }> {
    if (!this.token) {
      return {
        success: false,
        description: 'TELEGRAM_BOT_TOKEN is not configured on Cloudflare Worker Secrets.',
      };
    }

    const payload: Record<string, unknown> = {
      url,
      allowed_updates: ['message', 'callback_query'],
    };

    if (secretToken && secretToken.trim().length > 0) {
      payload.secret_token = secretToken.trim();
    }

    try {
      const res = await fetch(`${this.baseUrl}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as {
        ok: boolean;
        description?: string;
        error_code?: number;
      };

      if (!res.ok || !data.ok) {
        console.error('Telegram setWebhook failed:', data);
        return {
          success: false,
          description: data.description || `HTTP error ${res.status}`,
          error_code: data.error_code || res.status,
        };
      }

      return {
        success: true,
        description: data.description || 'Webhook was set successfully',
      };
    } catch (err) {
      console.error('Error setting webhook:', err);
      return { success: false, description: String(err) };
    }
  }
}
