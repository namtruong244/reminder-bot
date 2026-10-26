import { describe, it, expect, vi, afterEach } from 'vitest';
import { NlpService } from '../src/services/nlp.service';

describe('NlpService', () => {
  const service = new NlpService(); // Fallback heuristic mode (no API key)

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prioritizes Gemini API first when apiKey is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      intent: 'CREATE_TASK',
                      title: 'Họp chiến lược quý 4',
                      description: 'Chuẩn bị slide doanh thu',
                      due_at_iso: '2026-10-23T15:00:00+07:00',
                      remind_before_minutes: 15,
                      priority: 'CRITICAL',
                      nagging_mode: true,
                      recurrence_rrule: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt(
      'Nhắc tôi 3h chiều mai họp chiến lược quý 4, nhớ chuẩn bị slide doanh thu, việc gấp'
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Họp chiến lược quý 4');
    expect(result.description).toBe('Chuẩn bị slide doanh thu');
    expect(result.remind_before_minutes).toBe(15);
  });

  it('correctly handles Gemini thinking parts (thought: true) before the JSON part', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    text: 'The user wants a reminder at 16:00. Timezone is +07:00. Priority is CRITICAL because of the word "gấp".',
                  },
                  {
                    text: JSON.stringify({
                      intent: 'CREATE_TASK',
                      title: 'Gửi báo cáo doanh số cho ban giám đốc',
                      description: null,
                      due_at_iso: '2026-10-23T16:00:00+07:00',
                      remind_before_minutes: 0,
                      priority: 'CRITICAL',
                      nagging_mode: true,
                      recurrence_rrule: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt('4h chiều gửi báo cáo doanh số cho ban giám đốc việc gấp');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Gửi báo cáo doanh số cho ban giám đốc');
    expect(result.priority).toBe('CRITICAL');
    expect(result.nagging_mode).toBe(true);
  });

  it('correctly handles Gemini output wrapped in markdown code fence', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '```json\n{\n  "intent": "CREATE_TASK",\n  "title": "Mua bánh sinh nhật",\n  "due_at_iso": "2026-10-23T18:00:00+07:00",\n  "remind_before_minutes": 15,\n  "priority": "MEDIUM",\n  "nagging_mode": false\n}\n```',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt('Tối nay mua bánh sinh nhật');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Mua bánh sinh nhật');
    expect(result.due_at_iso).toBe('2026-10-23T18:00:00+07:00');
  });

  it('falls through to the next model if Gemini returns 400 Bad Request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('thinkingConfig not supported', { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        intent: 'CREATE_TASK',
                        title: 'Đóng tiền điện',
                        due_at_iso: '2026-10-23T09:00:00+07:00',
                        priority: 'MEDIUM',
                        nagging_mode: false,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt('Sáng mai đóng tiền điện');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Đóng tiền điện');
  });

  it('tries fallback model if primary model returns 404 Not Found', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Model gemini-3.8-flash not found', { status: 404 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        intent: 'CREATE_TASK',
                        title: 'Tập thể dục',
                        due_at_iso: '2026-10-23T06:00:00+07:00',
                        priority: 'LOW',
                        nagging_mode: false,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const apiService = new NlpService('test_gemini_api_key', 'gemini-3.8-flash');
    const result = await apiService.parseUserPrompt('Sáng mai tập thể dục');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Tập thể dục');
  });

  it('tries fallback model if primary model times out', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        intent: 'CREATE_TASK',
                        title: 'Tập gym',
                        due_at_iso: '2026-10-23T18:00:00+07:00',
                        priority: 'LOW',
                        nagging_mode: false,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const apiService = new NlpService('test_gemini_api_key', 'gemini-3.8-flash');
    const result = await apiService.parseUserPrompt('Tối mai tập gym');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Tập gym');
    expect(result.debug?.source).toBe('GEMINI');
    expect(result.debug?.model).toBe('gemini-3-flash-preview');
  });

  it('tries fallback model if primary model returns 429 Quota Exceeded', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        intent: 'CREATE_TASK',
                        title: 'Đóng tiền lãi ngân hàng',
                        due_at_iso: '2026-12-20T09:00:00+07:00',
                        priority: 'MEDIUM',
                        nagging_mode: false,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const apiService = new NlpService('test_gemini_api_key', 'gemini-3.8-flash');
    const result = await apiService.parseUserPrompt('Ngày 20 tháng 12 đóng tiền lãi ngân hàng');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Đóng tiền lãi ngân hàng');
    expect(result.due_at_iso).toBe('2026-12-20T09:00:00+07:00');
    expect(result.debug?.source).toBe('GEMINI');
    expect(result.debug?.model).toBe('gemini-3-flash-preview');
  });

  it('falls back to local regex parser when Gemini API fails on all models', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt('trưa mai làm báo cáo tài chính');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('làm báo cáo tài chính');
    expect(result.due_at_iso).toContain('T12:00:00+07:00');
    expect(result.debug?.source).toBe('REGEX_FALLBACK');
  });

  it('correctly parses "ngày 20 tháng 12" in deterministic regex fallback mode', async () => {
    const result = await service.parseUserPrompt('Ngày 20 tháng 12 đóng tiền lãi ngân hàng');

    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title?.toLowerCase()).toBe('đóng tiền lãi ngân hàng');
    expect(result.due_at_iso).toContain('-12-20T09:00:00+07:00');
  });

  it('correctly parses "Chiều 5h về đi cắt tóc" with period before time', async () => {
    const result = await service.parseUserPrompt('Chiều 5h về đi cắt tóc');

    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title?.toLowerCase()).toBe('về đi cắt tóc');
    expect(result.due_at_iso).toContain('T17:00:00+07:00');
  });

  it('sanitizes reasoning leakage and Chinese thought text from Gemini title', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      intent: 'CREATE_TASK',
                      title:
                        'Về đi cắt tóc延期已过时，请注意检查日期。Due: 2026-10-23T17:00:00+07:00 -> {"intent":"CREATE_TASK","title":"Về đi cắt tóc","due_at_iso":"2026-10-23T17:00:00+07:00"}',
                      due_at_iso: null,
                      priority: 'MEDIUM',
                      nagging_mode: false,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const apiService = new NlpService('test_gemini_api_key');
    const result = await apiService.parseUserPrompt('Chiều 5h về đi cắt tóc');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('Về đi cắt tóc');
    expect(result.due_at_iso).toContain('T17:00:00+07:00');
  });

  it('detects list tasks intent', async () => {
    const result = await service.parseUserPrompt('Xem danh sách công việc của tôi');
    expect(result.intent).toBe('LIST_TASKS');
  });

  it('does NOT misclassify task containing the phrase "danh sách" as LIST_TASKS', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi 3h chiều mai gửi danh sách khách hàng cho sếp');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('gửi danh sách khách hàng cho sếp');
    expect(result.due_at_iso).toContain('T15:00:00+07:00');
  });

  it('extracts task with minutes delay and critical priority heuristic', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi gọi điện cho sếp sau 15 phút, việc gấp');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('CRITICAL');
    expect(result.nagging_mode).toBe(true);
    expect(result.due_at_iso).toBeDefined();
    expect(result.title).toContain('gọi điện cho sếp');
  });

  it('extracts task with hours delay', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi nộp báo cáo sau 2 tiếng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('MEDIUM');
    expect(result.due_at_iso).toBeDefined();
  });

  it('extracts "Uống nước 10p nữa" correctly', async () => {
    const result = await service.parseUserPrompt('Uống nước 10p nữa');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('Uống nước');
    expect(result.remind_before_minutes).toBe(0);
    expect(result.due_at_iso).toBeDefined();
  });

  it('extracts "4 rưỡi chiều nay" correctly', async () => {
    const result = await service.parseUserPrompt('Nhắc sau 4 rưỡi chiều nay nộp báo cáo');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('nộp báo cáo');
    expect(result.due_at_iso).toContain('T16:30:00+07:00');
  });

  it('extracts "trưa mai làm..." correctly', async () => {
    const result = await service.parseUserPrompt('trưa mai làm báo cáo tài chính');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('làm báo cáo tài chính');
    expect(result.due_at_iso).toBeDefined();
    expect(result.due_at_iso).toContain('T12:00:00+07:00');
    expect(result.remind_before_minutes).toBe(0);

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const expectedYear = tomorrow.getFullYear();
    expect(result.due_at_iso).toContain(`${expectedYear}-`);
  });

  it('extracts "thanh toán tiền điện ngày 4 hàng tháng" correctly', async () => {
    const result = await service.parseUserPrompt('thanh toán tiền điện ngày 4 hàng tháng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('thanh toán tiền điện');
    expect(result.recurrence_rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=4');
    expect(result.due_at_iso).toBeDefined();
    expect(result.due_at_iso).toContain('-04T09:00:00+07:00');

    const dueDate = new Date(result.due_at_iso!);
    expect(dueDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('extracts "4h45 chiều mai nộp báo cáo" capturing full minutes', async () => {
    const result = await service.parseUserPrompt('4h45 chiều mai nộp báo cáo');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('nộp báo cáo');
    expect(result.due_at_iso).toContain('T16:45:00+07:00');
  });

  it('does not falsely set minute to 30 when message contains number 30 elsewhere', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi 2h chiều gửi 30 bản hợp đồng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.due_at_iso).toContain('T14:00:00+07:00');
    expect(result.title).toContain('30 bản hợp đồng');
  });

  it('extracts "sáng mốt đi khám bệnh" (+2 days) correctly', async () => {
    const result = await service.parseUserPrompt('sáng mốt đi khám bệnh');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('đi khám bệnh');
    expect(result.due_at_iso).toContain('T08:00:00+07:00');
  });

  it('extracts "mỗi ngày 8h sáng uống thuốc" correctly', async () => {
    const result = await service.parseUserPrompt('mỗi ngày 8h sáng uống thuốc');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('uống thuốc');
    expect(result.recurrence_rrule).toBe('FREQ=DAILY');
    expect(result.due_at_iso).toContain('T08:00:00+07:00');
  });

  it('extracts "thứ 2 hàng tuần họp giao ban" correctly', async () => {
    const result = await service.parseUserPrompt('thứ 2 hàng tuần họp giao ban');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('họp giao ban');
    expect(result.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(result.due_at_iso).toContain('T09:00:00+07:00');
  });

  it('extracts explicit remind_before_minutes when user specifies "nhắc trước 30 phút"', async () => {
    const result = await service.parseUserPrompt('9h sáng mai họp khách hàng, nhắc trước 30 phút');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('họp khách hàng');
    expect(result.remind_before_minutes).toBe(30);
    expect(result.due_at_iso).toContain('T09:00:00+07:00');
  });

  it('extracts standalone weekday "Chiều thứ 6 lúc 17h đón con ở trường, việc gấp"', async () => {
    const result = await service.parseUserPrompt('Chiều thứ 6 lúc 17h đón con ở trường, việc gấp');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('CRITICAL');
    expect(result.title).toBe('đón con ở trường');
    expect(result.due_at_iso).toContain('T17:00:00+07:00');
  });
});
