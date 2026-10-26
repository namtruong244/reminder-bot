import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NlpService } from '../src/services/nlp.service';
import { calculateNextRecurrence } from '../src/utils/datetime';

// Fixed clock: Monday 2026-10-26 08:00 (+07:00)
const NOW = '2026-10-26T08:00:00+07:00';

describe('NlpService regex parser (fixed clock)', () => {
  const service = new NlpService(); // no API key -> regex parser

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: Array<{
    text: string;
    due?: string;
    title?: string;
    rrule?: string | null;
    priority?: string;
    assumed?: boolean;
  }> = [
    { text: 'Nhắc tôi 3h chiều mai gửi hợp đồng cho khách, việc gấp nhé', due: '2026-10-27T15:00:00+07:00', title: 'gửi hợp đồng cho khách', priority: 'CRITICAL' },
    { text: 'thứ 6 tuần sau 9h họp', due: '2026-11-06T09:00:00+07:00', title: 'họp' },
    { text: '7h tối thứ 6 đi ăn cưới', due: '2026-10-30T19:00:00+07:00', title: 'đi ăn cưới' },
    { text: '1h trưa họp', due: '2026-10-26T13:00:00+07:00', title: 'họp' },
    { text: '12h trưa ăn cơm', due: '2026-10-26T12:00:00+07:00', title: 'ăn cơm' },
    { text: 'gọi cho mẹ lúc 9 giờ', due: '2026-10-26T09:00:00+07:00', title: 'gọi cho mẹ' },
    { text: '9h kém 15 họp', due: '2026-10-26T08:45:00+07:00', title: 'họp' },
    { text: 'mai nhớ mua 2 hộp sữa', due: '2026-10-27T09:00:00+07:00', title: 'nhớ mua 2 hộp sữa' },
    { text: 'mai đóng tiền nhà 5 triệu', due: '2026-10-27T09:00:00+07:00', title: 'đóng tiền nhà 5 triệu' },
    { text: '30 phút nữa tắt bếp', due: '2026-10-26T01:30:00.000Z', title: 'tắt bếp' },
    { text: '2 ngày nữa gia hạn hộ chiếu', due: '2026-10-28T09:00:00+07:00', title: 'gia hạn hộ chiếu' },
    { text: 'đầu tuần sau nộp báo cáo', due: '2026-11-02T09:00:00+07:00', title: 'nộp báo cáo' },
    { text: 'cuối tháng đóng tiền điện', due: '2026-10-31T09:00:00+07:00', title: 'đóng tiền điện' },
    { text: 'thứ 2 và thứ 4 hàng tuần đi gym 6h sáng', due: '2026-10-28T06:00:00+07:00', title: 'đi gym', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
    // titles must keep numbers and given names
    { text: 'họp 2 phòng ban lúc 14h', due: '2026-10-26T14:00:00+07:00', title: 'họp 2 phòng ban' },
    { text: 'mua 3 phở lúc 17h', due: '2026-10-26T17:00:00+07:00', title: 'mua 3 phở' },
    { text: 'gặp anh Mai 3h chiều mai', due: '2026-10-27T15:00:00+07:00', title: 'gặp anh Mai' },
    // "gấp" as verb is not urgency
    { text: 'mai gấp quần áo', due: '2026-10-27T09:00:00+07:00', title: 'gấp quần áo', priority: 'MEDIUM' },
    { text: 'mai họp 9h, việc gấp', due: '2026-10-27T09:00:00+07:00', title: 'họp', priority: 'CRITICAL' },
    // no time at all: flagged instead of silently guessed
    { text: 'nhắc tôi gọi điện cho anh Mai', title: 'gọi điện cho anh Mai', assumed: true },
  ];

  for (const c of cases) {
    it(`parses "${c.text}"`, async () => {
      const r = await service.parseUserPrompt(c.text);
      expect(r.intent).toBe('CREATE_TASK');
      if (c.due) {
        expect(new Date(r.due_at_iso!).toISOString()).toBe(new Date(c.due).toISOString());
      }
      if (c.title) expect(r.title?.toLowerCase()).toBe(c.title.toLowerCase());
      if (c.rrule !== undefined) expect(r.recurrence_rrule).toBe(c.rrule);
      if (c.priority) expect(r.priority).toBe(c.priority);
      expect(!!r.time_assumed).toBe(!!c.assumed);
    });
  }

  it('detects list intent', async () => {
    expect((await service.parseUserPrompt('xem việc hôm nay')).intent).toBe('LIST_TASKS');
  });
});

describe('Gemini output sanitizing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const mockGemini = (payload: object) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
        { status: 200 }
      )
    );

  it('replaces a title polluted with date debris by the cleaned user text', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp (20-06T:00+) họp', due_at_iso: '2026-11-06T09:00:00+07:00' });
    const r = await new NlpService('k').parseUserPrompt('thứ 6 tuần sau 9h họp');
    expect(r.title).toBe('Họp');
  });

  it('drops an invalid RRULE and keeps a valid one', async () => {
    mockGemini({ intent: 'CREATE_TASK', title: 'Tập gym', due_at_iso: '2026-10-27T06:00:00+07:00', recurrence_rrule: 'EVERY MONDAY' });
    const bad = await new NlpService('k').parseUserPrompt('tập gym');
    expect(bad.recurrence_rrule).toBeNull();

    mockGemini({ intent: 'CREATE_TASK', title: 'Tập gym', due_at_iso: '2026-10-27T06:00:00+07:00', recurrence_rrule: 'freq=weekly;byday=mo,we' });
    const ok = await new NlpService('k').parseUserPrompt('tập gym');
    expect(ok.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
  });

  it('strips wrapping quotes and rolls a past recurring first occurrence forward', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW)); // Mon 08:00
    mockGemini({
      intent: 'CREATE_TASK',
      title: "'Đi gym'",
      due_at_iso: '2026-10-26T06:00:00+07:00', // Monday 06:00 already passed
      recurrence_rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
    });
    const r = await new NlpService('k').parseUserPrompt('thứ 2 và thứ 4 hàng tuần đi gym 6h sáng');
    expect(r.title).toBe('Đi gym');
    expect(new Date(r.due_at_iso!).toISOString()).toBe('2026-10-27T23:00:00.000Z'); // Wed 06:00 +07
  });

  it('recovers a recurrence the model dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockGemini({ intent: 'CREATE_TASK', title: 'Đi gym', due_at_iso: '2026-10-28T06:00:00+07:00', recurrence_rrule: null });
    const r = await new NlpService('k').parseUserPrompt('thứ 2 và thứ 4 hàng tuần đi gym 6h sáng');
    expect(r.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(new Date(r.due_at_iso!).toISOString()).toBe('2026-10-27T23:00:00.000Z');
  });

  it('keeps model titles untouched when no time words leaked (names and quantities)', async () => {
    mockGemini({ intent: 'CREATE_TASK', title: 'Gọi anh Mai mua 2 phở', due_at_iso: '2026-10-27T09:00:00+07:00' });
    const r = await new NlpService('k').parseUserPrompt('mai gọi anh Mai mua 2 phở');
    expect(r.title).toBe('Gọi anh Mai mua 2 phở');
  });
});

describe('calculateNextRecurrence multi BYDAY', () => {
  it('goes from Monday to Wednesday for BYDAY=MO,WE', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const due = '2026-10-26T23:00:00.000Z'; // Mon 06:00 +07 -> Tue 06:00? use local: 2026-10-26T23:00Z = Tue 06:00 local
    const mon = '2026-10-25T23:00:00.000Z'; // Mon 06:00 local
    const next = calculateNextRecurrence(mon, mon, 'FREQ=WEEKLY;BYDAY=MO,WE', 'Asia/Ho_Chi_Minh');
    expect(next.dueAt).toBe('2026-10-27T23:00:00.000Z'); // Wed 06:00 local
    void due;
    vi.useRealTimers();
  });
});
