import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NlpService } from '../src/services/nlp.service';

// Opt-in live test against the real Gemini API:
//   GEMINI_API_KEY=... [LLM_MODEL=...] pnpm vitest run tests/nlp.gemini.live.test.ts
// Fixed clock: Monday 2026-10-26 08:00 (+07:00). Only Date is faked so fetch timeouts still work.
const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const KEY = env.GEMINI_API_KEY;

const cases: Array<{
  text: string;
  due?: string;
  title?: RegExp;
  rrule?: RegExp;
  priority?: string;
  intent?: string;
}> = [
  { text: 'Nhắc tôi 3h chiều mai gửi hợp đồng cho khách, việc gấp nhé', due: '2026-10-27T15:00:00+07:00', title: /^gửi hợp đồng cho khách$/i, priority: 'CRITICAL' },
  { text: 'thứ 6 tuần sau 9h họp', due: '2026-11-06T09:00:00+07:00', title: /^họp$/i },
  { text: '1h trưa họp', due: '2026-10-26T13:00:00+07:00', title: /^họp$/i },
  { text: 'gọi cho mẹ lúc 9 giờ', due: '2026-10-26T09:00:00+07:00', title: /gọi cho mẹ/i },
  { text: '9h kém 15 họp', due: '2026-10-26T08:45:00+07:00', title: /^họp$/i },
  { text: 'mai nhớ mua 2 hộp sữa', due: '2026-10-27T09:00:00+07:00', title: /2 hộp sữa/i },
  { text: '2 ngày nữa gia hạn hộ chiếu', due: '2026-10-28T09:00:00+07:00', title: /gia hạn hộ chiếu/i },
  { text: 'đầu tuần sau nộp báo cáo', due: '2026-11-02T09:00:00+07:00', title: /nộp báo cáo/i },
  { text: 'cuối tháng đóng tiền điện', due: '2026-10-31T09:00:00+07:00', title: /đóng tiền điện/i },
  { text: 'ngày 20 tháng 12 đóng tiền lãi ngân hàng', due: '2026-12-20T09:00:00+07:00', title: /đóng tiền lãi ngân hàng/i },
  { text: 'thứ 2 và thứ 4 hàng tuần đi gym 6h sáng', due: '2026-10-28T06:00:00+07:00', title: /đi gym/i, rrule: /^FREQ=WEEKLY;BYDAY=(MO,WE|WE,MO)$/ },
  { text: 'ngày 30 hàng tháng trả nợ', due: '2026-10-30T09:00:00+07:00', rrule: /FREQ=MONTHLY;BYMONTHDAY=30/ },
  { text: 'họp 2 phòng ban lúc 14h', due: '2026-10-26T14:00:00+07:00', title: /họp 2 phòng ban/i },
  { text: 'gặp anh Mai 3h chiều mai', due: '2026-10-27T15:00:00+07:00', title: /gặp anh Mai/i },
  { text: 'mai gấp quần áo', due: '2026-10-27T09:00:00+07:00', title: /gấp quần áo/i, priority: 'MEDIUM' },
  { text: 'Chiều 5h về đi cắt tóc', due: '2026-10-26T17:00:00+07:00', title: /về đi cắt tóc/i },
  { text: 'xem danh sách việc', intent: 'LIST_TASKS' },
];

describe.skipIf(!KEY)('NlpService against live Gemini', () => {
  const service = new NlpService(KEY, env.LLM_MODEL);

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T08:00:00+07:00'));
  });
  afterAll(() => vi.useRealTimers());

  for (const c of cases) {
    it(`"${c.text}"`, async () => {
      const r = await service.parseUserPrompt(c.text);
      // A regex fallback would make this test meaningless
      expect(r.debug?.source, `fell back: ${r.debug?.error}`).toBe('GEMINI');
      expect(r.intent).toBe(c.intent ?? 'CREATE_TASK');
      if (c.due) expect(new Date(r.due_at_iso!).toISOString()).toBe(new Date(c.due).toISOString());
      if (c.title) expect(r.title).toMatch(c.title);
      if (c.rrule) expect(r.recurrence_rrule ?? '').toMatch(c.rrule);
      if (c.priority) expect(r.priority).toBe(c.priority);
    }, 60_000);
  }
});
