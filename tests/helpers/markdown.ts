/**
 * Minimal checker for Telegram legacy "Markdown": *bold*, _italic_, `code`, [link](url).
 * Entities cannot nest and every opener needs a closer; otherwise Telegram answers HTTP 400
 * and the bot falls back to plain text, so the user sees literal asterisks.
 */
export function markdownError(text: string): string | null {
  let open: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (open === '`') {
      if (ch === '`') open = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      if (open) return `code span opened inside ${open} at ${i}`;
      open = '`';
    } else if (ch === '*' || ch === '_') {
      if (open === null) open = ch;
      else if (open === ch) open = null;
      else return `"${ch}" inside ${open} at ${i}: …${text.slice(Math.max(0, i - 25), i + 10)}…`;
    }
  }
  return open ? `unclosed ${open}` : null;
}
