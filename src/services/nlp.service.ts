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

    // Fallback if no API key is provided
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
2. Thời gian tuyệt đối trong ngày:
   - "Sáng": mặc định 08:00 (hoặc giờ cụ thể, VD: "9h sáng" = 09:00).
   - "Trưa": mặc định 12:00 (hoặc "11h30 trưa", "11 rưỡi trưa" = 11:30).
   - "Chiều": giờ chiều = giờ + 12 (nếu người dùng nói từ 1h-6h).
     VD: "4 rưỡi chiều nay" = 16:30:00 ngày hôm nay!
     VD: "4h chiều", "4 giờ chiều" = 16:00:00 ngày hôm nay!
     VD: "1h chiều" = 13:00:00 ngày hôm nay!
   - "Tối": giờ tối = giờ + 12 (nếu nói từ 6h-11h).
     VD: "8h tối nay" = 20:00:00 ngày hôm nay!
     VD: "8 rưỡi tối" = 20:30:00 ngày hôm nay!
3. Ngày hẹn:
   - "Hôm nay", "chiều nay", "tối nay", "trưa nay": dùng ngày hiện tại (${currentIso.split('T')[0]}).
   - "Mai", "sáng mai": ngày hiện tại + 1 ngày.
   - "Mốt", "ngày kia": ngày hiện tại + 2 ngày.
4. Quy tắc trường due_at_iso:
   - BẮT BUỘC có offset múi giờ +07:00 (Ví dụ: "2026-10-21T16:30:00+07:00").
   - TUYỆT ĐỐI KHÔNG dùng ký tự "Z" và KHÔNG ĐƯỢC bỏ trống phần offset.
5. Quy tắc trường remind_before_minutes:
   - Nếu người dùng nhắc việc làm ngay hoặc trong vòng 45 phút tới (VD: "10p nữa", "sau 15 phút"): đặt remind_before_minutes = 0.
   - Nếu công việc diễn ra sau đó (VD: chiều nay, tối nay, ngày mai): đặt remind_before_minutes = 0 nếu người dùng chỉ định giờ nhắc cụ thể, hoặc 15 nếu là hẹn hạn chót.
6. Mức độ ưu tiên:
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
   * Lightweight deterministic parser for common phrases or offline fallback.
   */
  private heuristicFallback(text: string, currentIso: string): NlpExtractedTask {
    const lower = text.toLowerCase();

    // Intent detection
    if (lower.startsWith('xem việc') || lower.includes('danh sách') || lower === 'list') {
      return { intent: 'LIST_TASKS' };
    }

    const isCritical = /gấp|khẩn|quan trọng|nhớ nhắc kỹ/.test(lower);
    const priority = isCritical ? 'CRITICAL' : 'MEDIUM';

    // 1. Check relative minutes/hours: "10p nữa", "sau 10 phút", "trong 15p", "2 tiếng nữa"
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
      const cleanTitle = text
        .replace(/nhắc (?:tôi|mình|em)?/i, '')
        .replace(/(?:sau|trong)?\s*\d+\s*(?:phút|tiếng|giờ|p|h)\s*(?:nữa)?/i, '')
        .replace(/nửa\s+(?:tiếng|giờ)\s*(?:nữa)?/i, '')
        .replace(/gấp|khẩn|quan trọng/i, '')
        .trim();

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

    // 2. Check absolute time: "4 rưỡi chiều nay", "4h chiều", "16h30", "8h tối"
    const chieuMatch = lower.match(/(\d+)(?:\s*(?:rưỡi|h30|:30))?\s*chiều/);
    const toiMatch = lower.match(/(\d+)(?:\s*(?:rưỡi|h30|:30))?\s*tối/);
    const sangMatch = lower.match(/(\d+)(?:\s*(?:rưỡi|h30|:30))?\s*sáng/);

    let targetHour: number | null = null;
    let targetMinute = 0;

    if (chieuMatch) {
      let h = parseInt(chieuMatch[1], 10);
      if (h < 12) h += 12;
      targetHour = h;
      if (lower.includes('rưỡi') || lower.includes('30')) targetMinute = 30;
    } else if (toiMatch) {
      let h = parseInt(toiMatch[1], 10);
      if (h < 12) h += 12;
      targetHour = h;
      if (lower.includes('rưỡi') || lower.includes('30')) targetMinute = 30;
    } else if (sangMatch) {
      targetHour = parseInt(sangMatch[1], 10);
      if (lower.includes('rưỡi') || lower.includes('30')) targetMinute = 30;
    }

    if (targetHour !== null) {
      const isTomorrow = lower.includes('mai');
      const now = new Date();
      if (isTomorrow) now.setDate(now.getDate() + 1);

      const dateStr = now.toISOString().split('T')[0];
      const hStr = targetHour.toString().padStart(2, '0');
      const mStr = targetMinute.toString().padStart(2, '0');
      const localIso = `${dateStr}T${hStr}:${mStr}:00+07:00`;

      const cleanTitle = text
        .replace(/nhắc (?:tôi|mình|em)?/i, '')
        .replace(/(?:sau\s+)?\d+(?:\s*(?:rưỡi|h30|:30))?\s*(?:chiều|tối|sáng)(?:\s*nay|\s*mai)?/i, '')
        .replace(/gấp|khẩn|quan trọng/i, '')
        .trim();

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

    return {
      intent: 'CREATE_TASK',
      title: text,
      due_at_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      remind_before_minutes: 0,
      priority,
      nagging_mode: isCritical,
      recurrence_rrule: null,
    };
  }
}
