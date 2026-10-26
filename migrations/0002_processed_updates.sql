-- Telegram update_id de-duplication (webhook retries / parallel isolates)
CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    received_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_received
ON processed_updates(received_at);
