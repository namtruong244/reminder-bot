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
Bạn là bộ máy phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại là: ${currentIso} (${dayOfWeek}).
Múi giờ mặc định: ${timezone}.

Nhiệm vụ: Phân tích câu nói của người dùng và trả về JSON theo đúng schema.
Quy tắc quy đổi thời gian tiếng Việt:
1. "Sáng": mặc định 08:00 nếu không nói rõ giờ. "Trưa": 12:00. "Chiều": +12 tiếng (VD: 3h chiều = 15:00). "Tối": 20:00 (hoặc +12 tiếng nếu từ 6h-11h tối).
2. "Mai" = ngày hiện tại + 1 ngày. "Mốt" / "Ngày kia" = ngày hiện tại + 2 ngày.
3. "Thứ X tuần sau": Tính đúng ngày Thứ X của tuần kế tiếp (Tuần bắt đầu từ Thứ Hai).
4. Nếu người dùng chỉ nói "nhắc sau X phút/tiếng nữa": due_at_iso = thời gian hiện tại + X phút/tiếng, và remind_before_minutes = 0.
5. Nếu người dùng dùng các từ "gấp", "quan trọng", "nhớ nhắc kỹ", "khẩn": đặt priority = "CRITICAL" và nagging_mode = true.
6. Nếu là việc định kỳ (VD: "mỗi ngày", "ngày 15 hàng tháng", "thứ 2 hàng tuần"): sinh chuỗi chuẩn iCalendar RRULE vào trường recurrence_rrule.
7. Đảm bảo trường due_at_iso có kèm offset múi giờ (VD: +07:00).
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

    // Check "sau X phút" or "sau X tiếng"
    const minuteMatch = lower.match(/(?:sau|trong)\s+(\d+)\s*(?:phút|p)/);
    const hourMatch = lower.match(/(?:sau|trong)\s+(\d+)\s*(?:tiếng|giờ|h)/);

    let minutesToAdd = 0;
    if (minuteMatch) {
      minutesToAdd += parseInt(minuteMatch[1], 10);
    }
    if (hourMatch) {
      minutesToAdd += parseInt(hourMatch[1], 10) * 60;
    }

    if (minutesToAdd > 0) {
      const dueDate = new Date(Date.now() + minutesToAdd * 60 * 1000);
      const cleanTitle = text
        .replace(/nhắc (?:tôi|mình|em)?/i, '')
        .replace(/(?:sau|trong)\s+\d+\s*(?:phút|tiếng|giờ|p|h)/i, '')
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

    return {
      intent: 'CREATE_TASK',
      title: text,
      due_at_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      remind_before_minutes: 10,
      priority,
      nagging_mode: isCritical,
      recurrence_rrule: null,
    };
  }
}
