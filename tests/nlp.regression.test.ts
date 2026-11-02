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
    { text: 'Họp sáng thứ 6 tuần sau lúc 9H', due: '2026-11-06T09:00:00+07:00', title: 'Họp' },
    { text: 'Lúc 15H30 gọi khách', due: '2026-10-26T15:30:00+07:00', title: 'gọi khách' },
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
    { text: 'đầu tuần sau nữa nộp báo cáo', due: '2026-11-09T09:00:00+07:00' },
    { text: 'thứ 6 tuần sau nữa 9h họp', due: '2026-11-13T09:00:00+07:00' },
    { text: 'đầu tuần sau nhắc tôi chuẩn bị cho chuyến đi tuần sau nữa', due: '2026-11-02T09:00:00+07:00' },
    { text: 'tập thể dục 6h sáng từ thứ 2 đến thứ 6 hàng tuần', due: '2026-10-27T06:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { text: 'hàng tuần từ thứ 2 tới thứ 6 đi làm lúc 7h', due: '2026-10-27T07:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { text: 'hàng tuần từ thứ 2 cho đến thứ 6 đi làm lúc 7h', due: '2026-10-27T07:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { text: 'hàng tuần từ thứ 2 đến hết thứ 6 đi làm lúc 7h', due: '2026-10-27T07:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { text: 'học tiếng Anh thứ 2 - thứ 4 - thứ 6 hàng tuần lúc 19h', due: '2026-10-26T19:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' },
    { text: 'hàng tuần từ thứ 7 đến thứ 2 trực cửa hàng lúc 8h', due: '2026-10-31T08:00:00+07:00', rrule: 'FREQ=WEEKLY;BYDAY=SA,SU,MO' },
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

  it('corrects a model that reads "thứ 6 tuần sau" as this week\'s Friday (said on Monday)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW)); // Mon 2026-10-26
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-10-30T09:00:00+07:00' });
    const r = await new NlpService('k').parseUserPrompt('Họp sáng thứ 6 tuần sau lúc 9H');
    expect(r.due_at_iso).toBe('2026-11-06T09:00:00+07:00');

    // Model's clock time is kept; only the calendar date is corrected
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-10-30T09:30:00+07:00' });
    const r2 = await new NlpService('k').parseUserPrompt('thứ 6 tuần tới 9h30 họp');
    expect(r2.due_at_iso).toBe('2026-11-06T09:30:00+07:00');

    // A correct model answer is left untouched
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-06T09:00:00+07:00' });
    const r3 = await new NlpService('k').parseUserPrompt('Họp sáng thứ 6 tuần sau lúc 9H');
    expect(r3.due_at_iso).toBe('2026-11-06T09:00:00+07:00');
  });

  it('labels weeks (Monday start) in the calendar table sent to the model', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW)); // Mon 2026-10-26
    const spy = mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-06T09:00:00+07:00' });
    await new NlpService('k').parseUserPrompt('thứ 6 tuần sau 9h họp');
    const body = String(spy.mock.calls[0][1]?.body);
    expect(body).toContain('2026-10-30: Thứ Sáu [tuần này]');
    expect(body).toContain('2026-11-01: Chủ Nhật [tuần này]');
    expect(body).toContain('2026-11-02: Thứ Hai [tuần sau]');
    expect(body).toContain('2026-11-06: Thứ Sáu [tuần sau]');
  });

  // Asserts the model's due date survives sanitizing for a phrase the week-relative correction must not touch
  const keepsModelDate = async (text: string, due: string, now = NOW, timezone?: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: due });
    const r = await new NlpService('k').parseUserPrompt(text, timezone);
    expect(r.due_at_iso).toBe(due);
  };

  it('reads an offset-less model time as user-local when correcting the week', async () => {
    // Workers run in UTC, where `new Date('…T20:00:00')` means 20:00Z rather than 20:00 in Vietnam
    vi.stubEnv('TZ', 'UTC');
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW)); // Mon 2026-10-26
      mockGemini({ intent: 'CREATE_TASK', title: 'Đi ăn', due_at_iso: '2026-10-30T20:00:00' });
      const r = await new NlpService('k').parseUserPrompt('tối thứ 6 tuần sau đi ăn');
      expect(r.due_at_iso).toBe('2026-11-06T20:00:00+07:00');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves the model date alone when the text names several weekdays', async () => {
    await keepsModelDate('Dời họp thứ 3 sang thứ 6 tuần sau 9h', '2026-11-06T09:00:00+07:00');
  });

  it('resolves "tuần sau nữa" to the week after next', async () => {
    await keepsModelDate('thứ 6 tuần sau nữa 9h họp', '2026-11-13T09:00:00+07:00');

    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-06T09:00:00+07:00' });
    const r = await new NlpService('k').parseUserPrompt('thứ 6 tuần sau nữa 9h họp');
    expect(r.due_at_iso).toBe('2026-11-13T09:00:00+07:00');
  });

  it('does not push "thứ X tuần này" into next week', async () => {
    await keepsModelDate('thứ 6 tuần này lúc năm giờ chiều họp', '2026-10-30T17:00:00+07:00', '2026-10-30T14:30:00+07:00');
  });

  it('ignores number ranges and durations next to "thứ X tuần sau"', async () => {
    await keepsModelDate('thứ 6 tuần sau họp 9-11h', '2026-11-06T09:00:00+07:00');
    await keepsModelDate('thứ 6 tuần sau họp 2-3 tiếng', '2026-11-06T09:00:00+07:00');
    await keepsModelDate('Thứ 6 tuần sau họp trong 2 tiếng', '2026-11-06T09:00:00+07:00', '2026-10-26T10:00:00+07:00');
    await keepsModelDate('thứ 6 tuần sau họp, nhắc tôi 30 phút trước', '2026-11-06T09:00:00+07:00');
  });

  it('keeps a recurring task starting next week on its requested start date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T08:00:00+07:00')); // Wed
    mockGemini({
      intent: 'CREATE_TASK',
      title: 'Họp',
      due_at_iso: '2026-11-02T09:00:00+07:00',
      recurrence_rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    const r = await new NlpService('k').parseUserPrompt('Họp thứ 4 hàng tuần, bắt đầu từ thứ 2 tuần sau 9h');
    expect(r.due_at_iso).toBe('2026-11-02T09:00:00+07:00');

    // Model drops the RRULE: the recovered rule must not drag the start back to this Monday
    vi.setSystemTime(new Date(NOW)); // Mon 2026-10-26 08:00
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-02T09:00:00+07:00' });
    const r2 = await new NlpService('k').parseUserPrompt('thứ 2 tuần sau họp 9h, lặp lại hàng tuần');
    expect(r2.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(r2.due_at_iso).toBe('2026-11-02T09:00:00+07:00');
  });

  it('keeps the local clock time when the week correction crosses a DST change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T10:00:00+02:00')); // Wed, Berlin summer time
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-10-23T09:00:00+02:00' });
    const r = await new NlpService('k').parseUserPrompt('thứ 6 tuần sau 9h họp', 'Europe/Berlin');
    expect(r.due_at_iso).toBe('2026-10-30T09:00:00+01:00');
  });

  it('runs the regex parser at most once while sanitizing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: null });
    const service = new NlpService('k');
    const spy = vi.spyOn(service as unknown as { fastPatternParse: () => unknown }, 'fastPatternParse');
    const r = await service.parseUserPrompt('thứ 6 tuần sau 9h họp');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.due_at_iso).toBe('2026-11-06T09:00:00+07:00');
  });

  it('tells the model the resolved date of a week-relative phrase', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const spy = mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-06T09:00:00+07:00' });
    await new NlpService('k').parseUserPrompt('thứ 6 tuần sau 9h họp');
    expect(String(spy.mock.calls[0][1]?.body)).toContain('\\"thứ 6 tuần sau\\" trong câu của người dùng = 2026-11-06 (Thứ Sáu)');
  });

  it('treats relative durations and offsets as the due time, not the weekday they mention', async () => {
    await keepsModelDate('30 phút nữa nhắc tôi chuẩn bị slide cho buổi họp thứ 2 tuần sau', '2026-10-26T08:30:00+07:00');
    await keepsModelDate('sau 2 tiếng nhắc tôi gửi lịch họp thứ 6 tuần sau', '2026-10-26T10:00:00+07:00');
    await keepsModelDate('1 tuần nữa nhắc tôi xem lại hợp đồng ký thứ 6 tuần sau', '2026-11-02T08:00:00+07:00');
    await keepsModelDate('lát nữa nhắc tôi đặt phòng cho chuyến đi thứ 6 tuần sau', '2026-10-26T08:30:00+07:00');
    await keepsModelDate('nhắc tôi mua quà 3 ngày trước thứ 6 tuần sau', '2026-11-03T09:00:00+07:00');

    vi.setSystemTime(new Date(NOW));
    const spy = mockGemini({ intent: 'CREATE_TASK', title: 'Gửi lịch', due_at_iso: '2026-10-26T10:00:00+07:00' });
    await new NlpService('k').parseUserPrompt('sau 2 tiếng nhắc tôi gửi lịch họp thứ 6 tuần sau');
    expect(String(spy.mock.calls[0][1]?.body)).not.toContain('trong câu của người dùng =');
  });

  it('accepts a late-night time just after the week-relative evening', async () => {
    await keepsModelDate('tối thứ 6 tuần sau 0h30 đi ăn đêm', '2026-11-07T00:30:00+07:00');
  });

  it('dates a missing model due time with the regex parser (week after next, ranges, ordinals)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: null });
    const r = await new NlpService('k').parseUserPrompt('thứ 6 tuần sau nữa 9h họp');
    expect(r.due_at_iso).toBe('2026-11-13T09:00:00+07:00');

    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: null });
    const r2 = await new NlpService('k').parseUserPrompt('thứ 6 tuần sau họp 9-11h');
    expect(r2.due_at_iso?.slice(0, 10)).toBe('2026-11-06');

    mockGemini({ intent: 'CREATE_TASK', title: 'Tiêm mũi thứ 2', due_at_iso: null });
    const r3 = await new NlpService('k').parseUserPrompt('Tiêm mũi thứ 2 vào thứ 6 tuần sau lúc 9h');
    expect(r3.due_at_iso).toBe('2026-11-06T09:00:00+07:00');
  });

  it('keeps an explicit recurrence start when recovering a dropped RRULE', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW)); // Mon 2026-10-26 08:00
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-02T09:00:00+07:00' });
    const r = await new NlpService('k').parseUserPrompt('Họp thứ 2 hàng tuần, bắt đầu từ thứ 2 tuần sau 9h');
    expect(r.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(r.due_at_iso).toBe('2026-11-02T09:00:00+07:00');

    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-16T09:00:00+07:00' });
    const r2 = await new NlpService('k').parseUserPrompt('Họp thứ 2 hàng tuần lúc 9h, bắt đầu từ ngày 16/11');
    expect(r2.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(r2.due_at_iso).toBe('2026-11-16T09:00:00+07:00');

    // The start weekday is not a repeat day, and the first occurrence is the first Wednesday from that start
    vi.setSystemTime(new Date('2026-10-28T08:00:00+07:00')); // Wed
    mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-02T09:00:00+07:00' });
    const r3 = await new NlpService('k').parseUserPrompt('Họp thứ 4 hàng tuần, bắt đầu từ thứ 2 tuần sau 9h');
    expect(r3.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
    expect(new Date(r3.due_at_iso!).toISOString()).toBe('2026-11-04T02:00:00.000Z');
  });

  // Asserts the week correction moves a wrong this-week model answer onto next week's date
  const correctsTo = async (text: string, modelDue: string, expected: string, now = NOW) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    mockGemini({ intent: 'CREATE_TASK', title: 'Việc', due_at_iso: modelDue });
    const r = await new NlpService('k').parseUserPrompt(text);
    expect(r.due_at_iso).toBe(expected);
  };

  it('corrects simple sentences: one "thứ X tuần sau", clock times and a remind-before phrase', async () => {
    const wrong = '2026-10-30T09:00:00+07:00';
    const right = '2026-11-06T09:00:00+07:00';
    await correctsTo('Họp thứ 6 tuần sau 9h, nhắc trước 30 phút', wrong, right);
    await correctsTo('thứ 6 tuần sau 9h họp, nhắc tôi trước 15 phút', wrong, right);
    await correctsTo('thứ 6 tuần sau 9h nộp thuế, nhắc tôi 1 ngày trước', wrong, right);
    await correctsTo('Thứ 6 tuần sau 9h họp, nhắc trước nửa tiếng', wrong, right);
    await correctsTo('gửi báo cáo cho khách thứ 6 tuần sau lúc 9h sáng', wrong, right);
    await correctsTo('Thứ 6 tuần sau 9h đi mua cây hoa, việc gấp nhé', wrong, right);
    await correctsTo('thứ 6 tuần sau 8 rưỡi họp', '2026-10-30T08:30:00+07:00', '2026-11-06T08:30:00+07:00');
  });

  it('leaves richer sentences to the model: no override and no prompt hint', async () => {
    // Each carries other date/time information, a second weekday or an ordinal, so the deterministic
    // resolver steps aside even when the model is wrong. A missed correction is the accepted trade-off.
    const richer = [
      'gặp Mai thứ 6 tuần sau 9h',
      'nộp báo cáo trước 9 giờ sáng thứ 6 tuần sau',
      'Họp tổng kết năm nay vào thứ 6 tuần sau 9h',
      'thứ 6 tuần sau 9h nộp báo cáo cuối tháng',
      'thứ 6 tuần sau 9h bắt đầu uống thuốc ngày 3 lần',
      'Tiêm mũi thứ 2 vào thứ 6 tuần sau lúc 9h',
      'Thứ 6 tuần sau 9h họp ở văn phòng đường 3/2',
      'thứ 6 tuần sau họp 9-11h',
    ];
    for (const text of richer) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
      const spy = mockGemini({ intent: 'CREATE_TASK', title: 'Việc', due_at_iso: '2026-10-30T09:00:00+07:00' });
      const r = await new NlpService('k').parseUserPrompt(text);
      expect(r.due_at_iso, text).toBe('2026-10-30T09:00:00+07:00');
      expect(String(spy.mock.calls[0][1]?.body), text).not.toContain('trong câu của người dùng =');
      spy.mockRestore();
    }
  });

  it('only corrects the right weekday in the wrong week, never a different day the model chose', async () => {
    await keepsModelDate('Thứ 6 tuần sau là sinh nhật vợ, nhắc tôi mua quà', '2026-11-05T09:00:00+07:00');
    await keepsModelDate('2h sáng thứ 6 tuần sau bay đi HN', '2026-11-07T02:00:00+07:00');
    await keepsModelDate('mua vé cho chuyến bay thứ 2 tuần sau ngay', '2026-10-26T08:05:00+07:00');
    // Two weeks off is still the same weekday in the wrong week
    await correctsTo('thứ 6 tuần sau nữa 9h họp', '2026-10-30T09:00:00+07:00', '2026-11-13T09:00:00+07:00');
  });

  it('keeps a weekly midnight "đêm chủ nhật" task on Sunday night', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockGemini({ intent: 'CREATE_TASK', title: 'Tổng kết', due_at_iso: '2026-11-02T00:00:00+07:00', recurrence_rrule: 'FREQ=WEEKLY;BYDAY=SU' });
    const r = await new NlpService('k').parseUserPrompt('12h đêm chủ nhật hàng tuần tổng kết');
    expect(r.due_at_iso).toBe('2026-11-02T00:00:00+07:00');
    // The rule follows the clock's weekday so the next occurrence is the next Sunday night, not Saturday night
    expect(r.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    const next = calculateNextRecurrence(r.due_at_iso!, r.due_at_iso!, r.recurrence_rrule!, 'Asia/Ho_Chi_Minh');
    expect(next.dueAt).toBe(new Date('2026-11-09T00:00:00+07:00').toISOString());

    // An unrelated "sáng" elsewhere does not cancel "đêm chủ nhật"
    mockGemini({ intent: 'CREATE_TASK', title: 'Soạn tài liệu', due_at_iso: '2026-11-02T00:00:00+07:00', recurrence_rrule: 'FREQ=WEEKLY;BYDAY=SU' });
    const r2 = await new NlpService('k').parseUserPrompt('12h đêm chủ nhật hàng tuần soạn tài liệu cho buổi họp sáng thứ 2');
    expect(r2.due_at_iso).toBe('2026-11-02T00:00:00+07:00');
  });

  it('rolls an offset-less recurring start onto its BYDAY in the user timezone', async () => {
    vi.stubEnv('TZ', 'UTC');
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-28T08:00:00+07:00')); // Wed
      mockGemini({ intent: 'CREATE_TASK', title: 'Họp', due_at_iso: '2026-11-02T09:00:00', recurrence_rrule: 'FREQ=WEEKLY;BYDAY=WE' });
      const r = await new NlpService('k').parseUserPrompt('Họp thứ 4 hàng tuần 9h, bắt đầu từ thứ 2 tuần sau');
      expect(new Date(r.due_at_iso!).toISOString()).toBe('2026-11-04T02:00:00.000Z');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not move the start of a period that ends on "thứ X tuần sau"', async () => {
    const now = '2026-11-02T10:00:00+07:00'; // Mon
    await keepsModelDate('Uống thuốc mỗi ngày lúc 8h sáng đến hết thứ 6 tuần sau', '2026-11-03T08:00:00+07:00', now);
    await keepsModelDate('Uống thuốc kháng sinh 8h sáng hàng ngày cho đến thứ 6 tuần sau', '2026-11-03T08:00:00+07:00', now);
    await keepsModelDate('Từ nay đến thứ 6 tuần sau, mỗi tối 9h nhắc tôi ôn thi', '2026-11-02T21:00:00+07:00', now);
  });

  it('does not move a reminder dated by another week phrase or the same weekday in another week', async () => {
    const now = '2026-11-02T08:00:00+07:00'; // Mon
    await keepsModelDate('Thứ 6 này nhắc tôi đặt vé xem phim cho thứ 6 tuần sau', '2026-11-06T09:00:00+07:00', now);
    await keepsModelDate('Chủ nhật này nhắc tôi đặt bàn cho tiệc chủ nhật tuần sau', '2026-11-08T09:00:00+07:00', now);
    await keepsModelDate('Chuẩn bị tài liệu cho buổi họp thứ 6 tuần sau nữa, nhắc tôi vào thứ 6 tuần sau', '2026-11-13T09:00:00+07:00', now);
    await keepsModelDate('Cuối tuần này nhắc tôi mua quà sinh nhật vợ, sinh nhật vào thứ 6 tuần sau', '2026-11-07T09:00:00+07:00', now);
    await keepsModelDate('Thứ 6 tuần sau hết hạn nộp hồ sơ, đầu tuần sau nhắc tôi chuẩn bị giấy tờ', '2026-11-09T09:00:00+07:00', now);
    await keepsModelDate('Tuần này nhắc tôi đặt vé máy bay cho chuyến công tác thứ 6 tuần sau', '2026-11-04T09:00:00+07:00', now);
  });

  it('keeps the night slack for "tối thứ 6 ... 2h sáng"', async () => {
    await keepsModelDate('Tối thứ 6 tuần sau đi bar, 2h sáng nhắc tôi gọi taxi về', '2026-11-07T02:00:00+07:00');
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
