import { NlpExtractedTask } from '../types/task';
import { getNowWithTimezone, getVietnameseDayOfWeek, DEFAULT_TZ } from '../utils/datetime';

const GEMINI_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['CREATE_TASK', 'LIST_TASKS', 'CANCEL_TASK', 'UNKNOWN'],
    },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    due_at_iso: { type: 'string', nullable: true },
    remind_before_minutes: { type: 'integer', nullable: true },
    priority: {
      type: 'string',
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    },
    nagging_mode: { type: 'boolean' },
    recurrence_rrule: { type: 'string', nullable: true },
  },
  required: ['intent'],
};

export class NlpService {
  constructor(
    private apiKey?: string,
    private model: string = 'gemini-2.5-flash'
  ) {}

  /**
   * Parses natural language input using Google Gemini Flash API with Structured Outputs.
   */
  async parseUserPrompt(
    text: string,
    timezone: string = DEFAULT_TZ
  ): Promise<NlpExtractedTask> {
    const currentIso = getNowWithTimezone(new Date(), timezone);
    const dayOfWeek = getVietnameseDayOfWeek(new Date(), timezone);

    // 1. FAST-PATH: Run local regex parser (< 1ms). Resolves common phrases instantly with 0 latency!
    const fastResult = this.fastPatternParse(text, currentIso);
    if (fastResult) {
      return fastResult;
    }

    // 2. Fallback to Gemini if no fast pattern match and no API key
    if (!this.apiKey) {
      return this.heuristicFallback(text, currentIso);
    }

    const systemPrompt = `
Bạn là trợ lý AI chuyên phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại tại Việt Nam là: ${currentIso} (${dayOfWeek}).
Múi giờ của người dùng: ${timezone} (UTC+07:00).

Nhiệm vụ: Phân tích câu nói của người dùng và trả về JSON theo đúng schema.

QUY TẮC QUY ĐỔI THỜI GIAN TIẾNG VIỆT (BẮT BUỘC TUÂN THỦ CHÍNH XÁC):
1. Thời gian tương đối:
   - "X phút nữa", "sau X phút", "trong X phút", "Xp nữa": due_at_iso = thời gian hiện tại + X phút, remind_before_minutes = 0.
   - "X tiếng nữa", "sau X giờ", "nửa tiếng nữa": due_at_iso = thời gian hiện tại + X tiếng (hoặc 30 phút), remind_before_minutes = 0.
2. Thời gian theo buổi trong ngày:
   - "Sáng": mặc định 08:00 (hoặc nếu nói giờ cụ thể, VD: "9h sáng" = 09:00, "9h30 sáng" = 09:30).
   - "Trưa": mặc định 12:00 (hoặc "11h trưa" = 11:00, "11h30 trưa" = 11:30, "12 rưỡi trưa" = 12:30).
   - "Chiều": giờ chiều = giờ + 12 (nếu nói từ 1h-6h, VD: "4h chiều" = 16:00, "4 rưỡi chiều" = 16:30, "4h45 chiều" = 16:45).
     Nếu người dùng chỉ nói "chiều mai", "chiều nay" mà không nói giờ cụ thể: mặc định 14:00.
   - "Tối": giờ tối = giờ + 12 (nếu nói từ 6h-11h, VD: "8h tối" = 20:00, "8 rưỡi tối" = 20:30).
     Nếu người dùng chỉ nói "tối mai", "tối nay" mà không nói giờ cụ thể: mặc định 20:00.
3. Ngày hẹn:
   - "Hôm nay", "trưa nay", "chiều nay", "tối nay", "sáng nay": dùng ngày hiện tại (${currentIso.split('T')[0]}).
   - "Mai", "trưa mai", "sáng mai", "chiều mai", "tối mai": ngày hiện tại + 1 ngày.
     VD: "trưa mai làm báo cáo" -> ngày mai lúc 12:00:00+07:00, title: "làm báo cáo".
   - "Mốt", "ngày kia", "trưa mốt", "sáng mốt", "chiều mốt", "tối mốt": ngày hiện tại + 2 ngày.
4. Việc lặp lại định kỳ (recurrence_rrule):
   - "ngày X hàng tháng" (hoặc "ngày X mỗi tháng", "mỗi tháng ngày X"):
     + recurrence_rrule = "FREQ=MONTHLY;BYMONTHDAY=X".
     + due_at_iso: Nếu ngày X của tháng hiện tại đã qua so với ngày hôm nay, lần nhắc đầu tiên PHẢI là ngày X của THÁNG KẾ TIẾP! (Nếu là tháng 12 thì sang tháng 1 năm sau). Nếu ngày X chưa tới trong tháng này, lấy ngày X của tháng này. Mặc định 09:00:00 sáng nếu không nói giờ.
     VD: Hôm nay ngày 22/10, "thanh toán tiền điện ngày 4 hàng tháng" -> due_at_iso là ngày 04/11 lúc 09:00:00+07:00, title là "thanh toán tiền điện".
   - "mỗi ngày" / "hàng ngày": recurrence_rrule = "FREQ=DAILY".
   - "thứ X hàng tuần" / "thứ X mỗi tuần": recurrence_rrule = "FREQ=WEEKLY;BYDAY=...".
5. Quy tắc trường due_at_iso:
   - BẮT BUỘC có offset múi giờ +07:00 (Ví dụ: "2026-10-23T12:00:00+07:00").
   - TUYỆT ĐỐI KHÔNG dùng ký tự "Z" và KHÔNG ĐƯỢC bỏ trống phần offset.
6. Tiêu đề (title):
   - Chỉ giữ lại nội dung công việc cốt lõi, LOẠI BỎ các từ chỉ thời gian và lời chào/mệnh lệnh như "nhắc tôi", "nhắc mình", "trưa mai", "ngày 4 hàng tháng", "chiều nay"...
7. Mức độ ưu tiên (priority):
   - Nếu có từ "gấp", "quan trọng", "nhớ nhắc kỹ", "khẩn": priority = "CRITICAL", nagging_mode = true.
   - Bình thường: priority = "MEDIUM", nagging_mode = false.
    `.trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_JSON_SCHEMA,
        temperature: 0.1,
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(3500),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini API error (${response.status}):`, errorText);
        return this.heuristicFallback(text, currentIso);
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJson) {
        console.warn('Gemini returned empty parts, falling back to heuristic');
        return this.heuristicFallback(text, currentIso);
      }

      const parsed = JSON.parse(rawJson) as NlpExtractedTask;
      return parsed;
    } catch (err) {
      console.error('Failed to parse with Gemini API:', err);
      return this.heuristicFallback(text, currentIso);
    }
  }

  /**
   * Lightweight deterministic fallback when Gemini API is unavailable.
   */
  private heuristicFallback(text: string, currentIso: string): NlpExtractedTask {
    return this.fastPatternParse(text, currentIso) || {
      intent: 'CREATE_TASK',
      title: this.buildCleanTitle(text) || text,
      due_at_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      remind_before_minutes: 0,
      priority: 'MEDIUM',
      nagging_mode: false,
      recurrence_rrule: null,
    };
  }

  /**
   * Fast-path deterministic parser for common Vietnamese time/task phrases.
   * Resolves phrases in < 1ms without calling external LLM.
   */
  private fastPatternParse(text: string, currentIso: string): NlpExtractedTask | null {
    const lower = text.toLowerCase().trim();

    // 1. Intent detection
    if (/(?:xem\s+(?:danh\s+sách|việc)|danh\s+sách|list|\/list)/i.test(lower)) {
      return { intent: 'LIST_TASKS' };
    }

    const isCritical = /gấp|khẩn|quan trọng|nhớ nhắc kỹ/.test(lower);
    const priority = isCritical ? 'CRITICAL' : 'MEDIUM';

    // Parse base date & tz offset from timezone-aware currentIso (e.g. "2026-10-22T10:30:00+07:00")
    const todayStr = currentIso.split('T')[0]; // "2026-10-22"
    const tzOffset = currentIso.match(/([+-]\d{2}:\d{2})$/)?.[1] || '+07:00';

    // ================================================================
    // STEP 1: Recurring patterns (e.g. "ngày 4 hàng tháng", "mỗi ngày")
    // ================================================================
    const recurResult = this.parseRecurringPattern(lower, text, todayStr, tzOffset, priority, isCritical);
    if (recurResult) {
      return recurResult;
    }

    // ================================================================
    // STEP 2: Absolute time WITH period (e.g. "4h30 chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "11h trưa")
    // ================================================================
    const timeWithPeriod = lower.match(
      /(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?\s*(sáng|trưa|chiều|tối)/
    );

    let targetHour: number | null = null;
    let targetMinute = 0;
    let matchedAbsoluteTime = false;

    if (timeWithPeriod) {
      const h = parseInt(timeWithPeriod[1], 10);
      if (h >= 1 && h <= 12) {
        const capturedMin = timeWithPeriod[2];
        const isRuoi = !!timeWithPeriod[3];
        const period = timeWithPeriod[4];

        targetMinute = capturedMin ? parseInt(capturedMin, 10) : (isRuoi ? 30 : 0);

        if (period === 'chiều' || period === 'tối') {
          targetHour = h < 12 ? h + 12 : h;
        } else {
          targetHour = h;
        }
        matchedAbsoluteTime = true;
      }
    }

    // ================================================================
    // STEP 3: Relative time (e.g. "10p nữa", "sau 15 phút", "trong 2 tiếng nữa", "nửa tiếng nữa")
    // ================================================================
    if (!matchedAbsoluteTime) {
      const relMinMatch = lower.match(/(?:sau|trong)?\s*(\d+)\s*(?:phút|p)\s*(?:nữa)?/);
      const relHourMatch = lower.match(/(?:sau|trong)?\s*(\d+)\s*(?:tiếng|giờ|h)\s*(?:nữa)?/);
      const isHalfHour = /nửa\s+(?:tiếng|giờ)/.test(lower);

      let minutesToAdd = 0;
      if (isHalfHour) {
        minutesToAdd = 30;
      } else if (relMinMatch && (lower.includes('nữa') || lower.includes('sau') || lower.includes('trong') || lower.includes('nhắc'))) {
        minutesToAdd = parseInt(relMinMatch[1], 10);
      } else if (relHourMatch && (lower.includes('nữa') || lower.includes('sau') || lower.includes('trong'))) {
        minutesToAdd = parseInt(relHourMatch[1], 10) * 60;
      }

      if (minutesToAdd > 0) {
        const dueDate = new Date(Date.now() + minutesToAdd * 60 * 1000);
        const cleanTitle = this.buildCleanTitle(text);

        return {
          intent: 'CREATE_TASK',
          title: cleanTitle || text,
          due_at_iso: dueDate.toISOString(),
          remind_before_minutes: 0,
          priority,
          nagging_mode: isCritical,
          recurrence_rrule: null,
        };
      }
    }

    // ================================================================
    // STEP 4: Standalone period + date words (e.g. "trưa mai", "sáng mai", "chiều nay", "tối mốt")
    // ================================================================
    if (!matchedAbsoluteTime) {
      const standalonePeriodMatch =
        lower.match(/\b(sáng|trưa|chiều|tối)\s*(?:nay|mai|mốt|ngày kia)\b/) ||
        lower.match(/\b(?:hôm nay|nay|ngày mai|mai|mốt|ngày kia)\s+(sáng|trưa|chiều|tối)\b/);

      if (standalonePeriodMatch) {
        const period = standalonePeriodMatch[1];
        const defaultHours: Record<string, number> = {
          sáng: 8,
          trưa: 12,
          chiều: 14,
          tối: 20,
        };
        targetHour = defaultHours[period] ?? 12;
        targetMinute = 0;
        matchedAbsoluteTime = true;
      }
    }

    // ================================================================
    // STEP 5: 24-hour format (e.g. "16h30", "15h", "14:45", "lúc 9h")
    // ================================================================
    if (!matchedAbsoluteTime) {
      const time24Match = lower.match(/(?:lúc\s+)?(\d{1,2})[h:](\d{1,2})?(?!\p{L})/u);
      if (time24Match) {
        const h = parseInt(time24Match[1], 10);
        if (h >= 0 && h <= 23) {
          targetHour = h;
          targetMinute = time24Match[2] ? parseInt(time24Match[2], 10) : 0;
          matchedAbsoluteTime = true;
        }
      }
    }

    // ================================================================
    // STEP 6: Combine extracted time and date offset
    // ================================================================
    if (targetHour !== null) {
      let dayOffset = 0;
      if (/\bmốt\b/.test(lower) || /\bngày\s*kia\b/.test(lower)) {
        dayOffset = 2;
      } else if (/\bmai\b/.test(lower) || /\bngày\s*mai\b/.test(lower)) {
        dayOffset = 1;
      }

      // Safe date calculation in UTC to avoid local timezone rollover issues
      const [baseY, baseM, baseD] = todayStr.split('-').map(Number);
      const targetDate = new Date(Date.UTC(baseY, baseM - 1, baseD + dayOffset));

      const yy = targetDate.getUTCFullYear();
      const mm = (targetDate.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = targetDate.getUTCDate().toString().padStart(2, '0');
      const hh = targetHour.toString().padStart(2, '0');
      const mi = targetMinute.toString().padStart(2, '0');
      const localIso = `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`;

      const cleanTitle = this.buildCleanTitle(text);

      return {
        intent: 'CREATE_TASK',
        title: cleanTitle || text,
        due_at_iso: localIso,
        remind_before_minutes: 0,
        priority,
        nagging_mode: isCritical,
        recurrence_rrule: null,
      };
    }

    return null;
  }

  /**
   * Parses Vietnamese recurring patterns such as "ngày 4 hàng tháng", "mỗi ngày", "thứ 2 hàng tuần".
   */
  private parseRecurringPattern(
    lower: string,
    originalText: string,
    todayStr: string,
    tzOffset: string,
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    isCritical: boolean
  ): NlpExtractedTask | null {
    const [baseY, baseM, baseD] = todayStr.split('-').map(Number);

    // --- "ngày X hàng tháng" / "ngày X mỗi tháng" ---
    const monthlyMatch = lower.match(/ngày\s+(\d{1,2})\s+(?:hàng|mỗi)\s+tháng/);
    if (monthlyMatch) {
      const dayOfMonth = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        let targetMonth = baseM;
        let targetYear = baseY;

        // If today is on or past this day in current month -> move to next month!
        if (baseD >= dayOfMonth) {
          targetMonth++;
          if (targetMonth > 12) {
            targetMonth = 1;
            targetYear++;
          }
        }

        const { hour, minute } = this.extractTimeFromText(lower);
        const mm = targetMonth.toString().padStart(2, '0');
        const dd = dayOfMonth.toString().padStart(2, '0');
        const hh = hour.toString().padStart(2, '0');
        const mi = minute.toString().padStart(2, '0');
        const cleanTitle = this.buildCleanTitle(originalText);

        return {
          intent: 'CREATE_TASK',
          title: cleanTitle || originalText,
          due_at_iso: `${targetYear}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
          remind_before_minutes: 0,
          priority,
          nagging_mode: isCritical,
          recurrence_rrule: `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth}`,
        };
      }
    }

    // --- "mỗi ngày" / "hàng ngày" ---
    if (/(?:mỗi|hàng)\s+ngày/.test(lower)) {
      const { hour, minute } = this.extractTimeFromText(lower);
      const tomorrow = new Date(Date.UTC(baseY, baseM - 1, baseD + 1));
      const yy = tomorrow.getUTCFullYear();
      const mm = (tomorrow.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = tomorrow.getUTCDate().toString().padStart(2, '0');
      const hh = hour.toString().padStart(2, '0');
      const mi = minute.toString().padStart(2, '0');
      const cleanTitle = this.buildCleanTitle(originalText);

      return {
        intent: 'CREATE_TASK',
        title: cleanTitle || originalText,
        due_at_iso: `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
        remind_before_minutes: 0,
        priority,
        nagging_mode: isCritical,
        recurrence_rrule: 'FREQ=DAILY',
      };
    }

    // --- "thứ X hàng tuần" / "thứ X mỗi tuần" ---
    const weeklyMatch = lower.match(/thứ\s+(hai|ba|tư|năm|sáu|bảy|\d)\s+(?:hàng|mỗi)\s+tuần/);
    if (weeklyMatch) {
      const dayMap: Record<string, string> = {
        hai: 'MO', '2': 'MO',
        ba: 'TU', '3': 'TU',
        'tư': 'WE', '4': 'WE',
        'năm': 'TH', '5': 'TH',
        'sáu': 'FR', '6': 'FR',
        'bảy': 'SA', '7': 'SA',
      };
      const rruleDay = dayMap[weeklyMatch[1]];
      if (rruleDay) {
        const jsWeekday: Record<string, number> = {
          MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0,
        };
        const targetWeekday = jsWeekday[rruleDay]!;
        const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
        const currentWeekday = todayDate.getUTCDay();
        let daysUntil = targetWeekday - currentWeekday;
        if (daysUntil <= 0) daysUntil += 7;

        const nextOccurrence = new Date(Date.UTC(baseY, baseM - 1, baseD + daysUntil));
        const { hour, minute } = this.extractTimeFromText(lower);
        const yy = nextOccurrence.getUTCFullYear();
        const mm = (nextOccurrence.getUTCMonth() + 1).toString().padStart(2, '0');
        const dd = nextOccurrence.getUTCDate().toString().padStart(2, '0');
        const hh = hour.toString().padStart(2, '0');
        const mi = minute.toString().padStart(2, '0');
        const cleanTitle = this.buildCleanTitle(originalText);

        return {
          intent: 'CREATE_TASK',
          title: cleanTitle || originalText,
          due_at_iso: `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
          remind_before_minutes: 0,
          priority,
          nagging_mode: isCritical,
          recurrence_rrule: `FREQ=WEEKLY;BYDAY=${rruleDay}`,
        };
      }
    }

    // --- "chủ nhật hàng tuần" / "chủ nhật mỗi tuần" ---
    if (/chủ\s*nhật\s+(?:hàng|mỗi)\s+tuần/.test(lower)) {
      const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
      const currentWeekday = todayDate.getUTCDay();
      let daysUntil = 0 - currentWeekday; // Sunday = 0
      if (daysUntil <= 0) daysUntil += 7;

      const nextOccurrence = new Date(Date.UTC(baseY, baseM - 1, baseD + daysUntil));
      const { hour, minute } = this.extractTimeFromText(lower);
      const yy = nextOccurrence.getUTCFullYear();
      const mm = (nextOccurrence.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = nextOccurrence.getUTCDate().toString().padStart(2, '0');
      const hh = hour.toString().padStart(2, '0');
      const mi = minute.toString().padStart(2, '0');
      const cleanTitle = this.buildCleanTitle(originalText);

      return {
        intent: 'CREATE_TASK',
        title: cleanTitle || originalText,
        due_at_iso: `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
        remind_before_minutes: 0,
        priority,
        nagging_mode: isCritical,
        recurrence_rrule: 'FREQ=WEEKLY;BYDAY=SU',
      };
    }

    return null;
  }

  /**
   * Helper: Extracts time-of-day from text, default to 09:00 if unspecified.
   */
  private extractTimeFromText(lower: string): { hour: number; minute: number } {
    const withPeriod = lower.match(
      /(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?\s*(sáng|trưa|chiều|tối)/
    );
    if (withPeriod) {
      let h = parseInt(withPeriod[1], 10);
      if (h >= 1 && h <= 12) {
        const minStr = withPeriod[2];
        const isRuoi = !!withPeriod[3];
        const period = withPeriod[4];
        const m = minStr ? parseInt(minStr, 10) : (isRuoi ? 30 : 0);
        if ((period === 'chiều' || period === 'tối') && h < 12) h += 12;
        return { hour: h, minute: m };
      }
    }

    const time24 = lower.match(/(\d{1,2})[h:](\d{1,2})?(?!\p{L})/u);
    if (time24) {
      const h = parseInt(time24[1], 10);
      if (h >= 0 && h <= 23) {
        return { hour: h, minute: time24[2] ? parseInt(time24[2], 10) : 0 };
      }
    }

    if (/trưa/.test(lower)) return { hour: 12, minute: 0 };
    if (/chiều/.test(lower)) return { hour: 14, minute: 0 };
    if (/tối/.test(lower)) return { hour: 20, minute: 0 };
    if (/sáng/.test(lower)) return { hour: 8, minute: 0 };

    return { hour: 9, minute: 0 };
  }

  /**
   * Helper: Strips date, time, and bot command expressions to produce a clean title.
   */
  private buildCleanTitle(text: string): string {
    return text
      // 1. Remove recurring patterns FIRST (before general hours or numbers to avoid "4 hàng" -> "4h")
      .replace(/ngày\s+\d{1,2}\s+(?:hàng|mỗi)\s+tháng/gi, '')
      .replace(/thứ\s+(?:\d|hai|ba|tư|năm|sáu|bảy)\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/chủ\s*nhật\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/(?:mỗi|hàng)\s+(?:ngày|tuần|tháng)/gi, '')
      // 2. Remove "nhắc tôi/mình/em"
      .replace(/nhắc\s*(?:tôi|mình|em)?\s*/gi, '')
      // 3. Remove time + period: "4h30 chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "8 giờ tối"
      .replace(/\d{1,2}\s*(?:h|giờ|:)?\s*\d{0,2}\s*(?:rưỡi)?\s*(?:sáng|trưa|chiều|tối)/gi, '')
      // 4. Remove standalone period + date: "trưa mai", "sáng mai", "chiều nay", "tối mốt"
      .replace(/(?:sáng|trưa|chiều|tối)\s*(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)/gi, '')
      .replace(/(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\s+(?:sáng|trưa|chiều|tối)/gi, '')
      // 5. Remove standalone date words: "hôm nay", "ngày mai", "ngày kia"
      .replace(/\bhôm\s*nay\b/gi, '')
      .replace(/\bngày\s*(?:mai|mốt|kia)\b/gi, '')
      .replace(/\b(?:mai|mốt)\b/gi, '')
      // 6. Remove 24h format: "16h30", "lúc 15h" — require h/: not immediately followed by letter
      .replace(/(?:lúc\s+)?\d{1,2}(?:h(?!\p{L})|:)\d{0,2}/gu, '')
      // 7. Remove relative time: "sau 10 phút", "2 tiếng nữa", "nửa tiếng nữa"
      .replace(/(?:sau|trong)?\s*\d+\s*(?:phút|p|tiếng|giờ)\s*(?:nữa)?/gi, '')
      .replace(/nửa\s+(?:tiếng|giờ)\s*(?:nữa)?/gi, '')
      // 8. Remove priority words
      .replace(/gấp|khẩn|quan trọng|nhớ nhắc kỹ/gi, '')
      // 9. Normalize whitespace and trailing symbols
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;]+$/g, '')
      .trim();
  }
}
