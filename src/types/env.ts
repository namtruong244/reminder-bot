export interface Env {
  // Cloudflare D1 Database binding
  DB: D1Database;

  // Environment Variables
  DEFAULT_TIMEZONE?: string;
  LLM_MODEL?: string;

  // Secrets (configured via wrangler secret put or local .dev.vars)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  GEMINI_API_KEY?: string;
  ENCRYPTION_SECRET_KEY?: string; // 32 bytes hex string (64 characters)
  IOS_BRIDGE_SECRET?: string; // Bearer token for iOS Shortcuts REST API
}
