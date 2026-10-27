import { NlpExtractedTask } from '../types/task';
import {
  getNowWithTimezone,
  getVietnameseDayOfWeek,
  getDaysInMonth,
  getLocalDateParts,
  calculateNextRecurrence,
  DEFAULT_TZ,
} from '../utils/datetime';

const GEMINI_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: {
      type: 'STRING',
      enum: ['CREATE_TASK', 'LIST_TASKS', 'CANCEL_TASK', 'UNKNOWN'],
    },
    title: { type: 'STRING', nullable: true },
    description: { type: 'STRING', nullable: true },
    due_at_iso: { type: 'STRING', nullable: true },
    remind_before_minutes: { type: 'INTEGER', nullable: true },
    priority: {
      type: 'STRING',
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      nullable: true,
    },
    nagging_mode: { type: 'BOOLEAN', nullable: true },
    recurrence_rrule: { type: 'STRING', nullable: true },
  },
  required: ['intent'],
};

// Kinship/title words that precede a given name, so "anh Mai" is not read as "tomorrow".
const NAME_PREFIX = '(?<!anh |chị |em |cô |chú |bác |dì |cậu |ông |bà |bạn |thầy |bé )';

// "gấp" only counts as urgency in an urgency context ("việc gấp", ", gấp", "gấp nhé", trailing),
// never as a verb ("gấp quần áo").
const CRITICAL_SRC =
  'việc\\s+gấp|(?:^|[\\s,;])gấp\\s*(?:nhé|nha|lắm|ạ)?\\s*[.!]*$|\\bgấp\\s+(?:nhé|nha|lắm)\\b|khẩn(?:\\s*cấp)?|quan\\s+trọng|nhớ\\s+nhắc\\s+kỹ';
const CRITICAL_RE = new RegExp(CRITICAL_SRC, 'i');
const CRITICAL_STRIP_RE = new RegExp(CRITICAL_SRC, 'gi');

const WEEKDAY_SRC = 'thứ\\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\\s*nhật';

// Week-relative date phrases ("thứ 6 tuần sau", "đầu tuần tới") that the deterministic parser resolves exactly
const WEEK_RELATIVE_DATE_RE = new RegExp(
  `(?:${WEEKDAY_SRC})\\s+tuần\\s+(?:sau|tới|này)|đầu\\s+tuần\\s+(?:sau|tới)`,
  'iu'
);

const VALID_RRULE_RE = /^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z]+=[A-Z0-9,+-]+)*$/;

const NLP_TOTAL_BUDGET_MS = 20000;
const NLP_MODEL_TIMEOUT_MS = 12000;

const L = '(?<!\\p{L})';
const R = '(?!\\p{L})';
const DAY_AFTER_RE = new RegExp(`${L}${NAME_PREFIX}(?:mốt|ngày\\s+kia)${R}`, 'u');
const TOMORROW_RE = new RegExp(`${L}${NAME_PREFIX}mai${R}`, 'u');
const TODAY_RE = new RegExp(`${L}(?:hôm\\s+nay|nay)${R}`, 'u');

// Detects time phrases left behind in a model-provided title, so we only clean when needed.
const TIME_RESIDUE_RE =
  /\d{1,2}\s*(?:h|giờ|:)\s*\d{0,2}|(?:sáng|trưa|chiều|tối)\s+(?:nay|mai|mốt|\d)|\d\s*(?:sáng|trưa|chiều|tối)|hôm nay|ngày mai|\d{1,2}\/\d{1,2}|(?:sau|trong)\s+\d+|\d+\s*(?:phút|tiếng|ngày)\s+nữa|(?:hàng|mỗi)\s+(?:ngày|tuần|tháng)/i;

interface GeminiCandidatePart {
  text?: string;
  thought?: boolean;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiCandidatePart[];
  };
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class NlpService {
  private apiKey?: string;
  private model: string;

  constructor(
    apiKey?: string,
    model?: string
  ) {
    this.apiKey = apiKey ? apiKey.trim().replace(/^["']|["']$/g, '').trim() : undefined;
    this.model = (model?.trim() || 'gemini-3.1-flash-lite').replace(/^models\//, '');
  }

  getApiKeyStatus(): { configured: boolean; preview?: string; length?: number } {
    if (!this.apiKey) {
      return { configured: false };
    }
    const len = this.apiKey.length;
    const preview = len > 8 ? `${this.apiKey.substring(0, 6)}...${this.apiKey.substring(len - 4)}` : '******';
    return { configured: true, preview, length: len };
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Generates a unified, high-precision system prompt for Vietnamese reminder extraction.
   */
  private getSystemPrompt(
    currentIso: string,
    dayOfWeek: string,
    timezone: string,
    tzOffset: string,
    now: Date = new Date()
  ): string {
    const calendar = this.buildCalendarTable(now, timezone);
    return `
Bạn là bộ máy phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại của người dùng là: ${currentIso} (${dayOfWeek}).
Múi giờ của người dùng: ${timezone} (UTC${tzOffset}).

Lịch 15 ngày tới (dùng bảng này để suy ra ngày, KHÔNG tự tính thứ):
${calendar}

Nhiệm vụ: Phân tích câu nói của người dùng và trả về JSON theo đúng schema.

QUY TẮC QUY ĐỔI THỜI GIAN TIẾNG VIỆT (BẮT BUỘC TUÂN THỦ CHÍNH XÁC):
1. Ngày tháng cụ thể ("ngày D tháng M" hoặc "D/M"):
   - due_at_iso = YYYY-MM-DDTHH:mm:00${tzOffset} (mặc định 09:00:00 nếu không nói giờ).
   - Nếu tháng M nhỏ hơn tháng hiện tại trong năm, tính sang năm tiếp theo.
   - Ví dụ: "ngày 20 tháng 12 đóng tiền lãi ngân hàng" -> due_at_iso = "2026-12-20T09:00:00${tzOffset}", title = "Đóng tiền lãi ngân hàng".
2. Thời gian tương đối:
   - "X phút nữa", "sau X phút", "trong X phút", "Xp nữa": due_at_iso = thời gian hiện tại + X phút, remind_before_minutes = 0.
   - "X tiếng nữa", "sau X giờ", "nửa tiếng nữa": due_at_iso = thời gian hiện tại + X tiếng (hoặc 30 phút), remind_before_minutes = 0.
3. Thời gian theo buổi trong ngày:
   - "Sáng": mặc định 08:00 (hoặc nếu nói giờ cụ thể, VD: "9h sáng", "sáng 9h" = 09:00, "9h30 sáng" = 09:30).
   - "Trưa": mặc định 12:00 (hoặc "11h trưa", "trưa 11h" = 11:00, "11h30 trưa", "trưa 11h30" = 11:30, "12 rưỡi trưa" = 12:30).
   - "Chiều": giờ chiều = giờ + 12 (nếu nói từ 1h-6h, VD: "4h chiều", "chiều 4h" = 16:00, "5h chiều", "chiều 5h" = 17:00, "4 rưỡi chiều" = 16:30).
     Nếu người dùng chỉ nói "chiều mai", "chiều nay" mà không nói giờ cụ thể: mặc định 14:00.
   - "Tối": giờ tối = giờ + 12 (nếu nói từ 6h-11h, VD: "8h tối", "tối 8h" = 20:00, "8 rưỡi tối" = 20:30).
     Nếu người dùng chỉ nói "tối mai", "tối nay" mà không nói giờ cụ thể: mặc định 20:00.
4. Ngày hẹn & thời điểm trong ngày:
   - Nếu không nói ngày nào mà chỉ nói giờ hẹn (ví dụ: "Chiều 5h...", "Tối 8h...", "9h sáng..."):
     + Nếu giờ hẹn trong ngày hôm nay chưa qua so với thời gian hiện tại (${currentIso}): BẮT BUỘC đặt due_at_iso là ngày HÔM NAY (${currentIso.split('T')[0]}).
       Ví dụ: Hiện tại ${currentIso}, câu "Chiều 5h về đi cắt tóc" -> due_at_iso = "${currentIso.split('T')[0]}T17:00:00${tzOffset}", title = "Về đi cắt tóc".
     + Chỉ khi giờ hẹn hôm nay đã qua thì mới tính sang ngày mai.
   - "Hôm nay", "trưa nay", "chiều nay", "tối nay", "sáng nay": dùng ngày hiện tại (${currentIso.split('T')[0]}).
   - "Mai", "trưa mai", "sáng mai", "chiều mai", "tối mai": ngày hiện tại + 1 ngày.
     VD: "trưa mai làm báo cáo" -> ngày mai lúc 12:00:00${tzOffset}, title: "Làm báo cáo".
   - "Mốt", "ngày kia", "trưa mốt", "sáng mốt", "chiều mốt", "tối mốt": ngày hiện tại + 2 ngày.
   - "Thứ X tuần sau" / "Thứ X tuần tới": ngày Thứ X có nhãn [tuần sau] trong bảng lịch (Tuần bắt đầu từ Thứ Hai), KHÔNG phải Thứ X gần nhất của [tuần này]. "Thứ X tuần này": ngày Thứ X có nhãn [tuần này]. "Thứ X" không kèm "tuần": ngày Thứ X gần nhất sắp tới.
   - "X ngày nữa", "sau X ngày": ngày hiện tại + X ngày. "Đầu tuần sau": Thứ Hai tuần sau. "Cuối tuần": Thứ Bảy gần nhất. "Cuối tháng": ngày cuối cùng của tháng hiện tại.
   - Giờ "kém": "9h kém 15" = 08:45. "Rưỡi" = :30. "Khuya"/"đêm": 23:00 nếu không nói giờ.
   - Nếu chỉ nói ngày mà không nói giờ: mặc định 09:00:00.
   - Nếu hoàn toàn không có thông tin thời gian: để due_at_iso = null (KHÔNG tự bịa giờ).
   - "Mai", "mốt", "nay" đứng sau từ chỉ người (anh Mai, chị Nay) là TÊN RIÊNG, không phải ngày.
5. Việc lặp lại định kỳ (recurrence_rrule):
   - "ngày X hàng tháng" (hoặc "ngày X mỗi tháng", "mỗi tháng ngày X"):
     + recurrence_rrule = "FREQ=MONTHLY;BYMONTHDAY=X".
     + due_at_iso: Nếu ngày X của tháng hiện tại đã qua so với thời điểm hiện tại, lần nhắc đầu tiên PHẢI là ngày X của THÁNG KẾ TIẾP! (Nếu là tháng 12 thì sang tháng 1 năm sau). Nếu ngày X chưa tới trong tháng này, lấy ngày X của tháng này. Mặc định 09:00:00 sáng nếu không nói giờ.
   - "mỗi ngày" / "hàng ngày": recurrence_rrule = "FREQ=DAILY".
   - "thứ X hàng tuần" / "thứ X mỗi tuần": recurrence_rrule = "FREQ=WEEKLY;BYDAY=..." (nhiều thứ thì nối bằng dấu phẩy: "thứ 2 và thứ 4 hàng tuần" -> BYDAY=MO,WE).
   - due_at_iso của việc lặp là lần xuất hiện ĐẦU TIÊN trong tương lai.
6. Quy tắc trường due_at_iso:
   - BẮT BUỘC có offset múi giờ ${tzOffset} (Ví dụ: "2026-10-23T12:00:00${tzOffset}").
   - TUYỆT ĐỐI KHÔNG dùng ký tự "Z" và KHÔNG ĐƯỢC bỏ trống phần offset.
7. QUY ĐỊNH BẮT BUỘC CHO TIÊU ĐỀ (title):
   - Trường "title" CHỈ CHỨA tên công việc thuần túy bằng tiếng Việt ngắn gọn (ví dụ: "Về đi cắt tóc").
   - TUYỆT ĐỐI LOẠI BỎ mọi từ chỉ thời gian ("chiều 5h", "5h chiều", "trưa mai", "ngày 20 tháng 12", "hôm nay"...) và từ "nhắc tôi". GIỮ NGUYÊN số lượng và tên riêng (VD: "mua 2 hộp sữa", "gọi anh Mai", "họp 2 phòng ban").
   - TUYỆT ĐỐI KHÔNG giải thích, KHÔNG suy luận, KHÔNG dùng tiếng nước ngoài (tiếng Anh, tiếng Trung...), KHÔNG lồng chuỗi JSON hay ghi chú vào trường "title".
   - Đối với intent "CREATE_TASK", trường "title" KHÔNG ĐƯỢC để trống hoặc null.
8. Mức độ ưu tiên (priority):
   - Nếu người dùng nhấn mạnh sự khẩn cấp ("việc gấp", "gấp nhé", "quan trọng", "nhớ nhắc kỹ", "khẩn"): priority = "CRITICAL", nagging_mode = true.
   - "gấp" là động từ (gấp quần áo, gấp giấy) thì KHÔNG phải khẩn cấp, và vẫn phải giữ trong title.
   - Bình thường: priority = "MEDIUM", nagging_mode = false.
9. Nếu người dùng muốn xem/liệt kê danh sách việc: intent = "LIST_TASKS".
   Nếu người dùng muốn hủy/xóa việc: intent = "CANCEL_TASK".
`.trim();
  }

  /**
   * Builds a 15-day lookup table so the model never has to compute weekdays itself.
   */
  private buildCalendarTable(now: Date, timezone: string): string {
    const rows: string[] = [];
    const labels = ['Hôm nay', 'Ngày mai', 'Ngày mốt'];
    // Weeks start on Monday; label each row so "tuần sau" never has to be inferred by the model
    const weekLabels = ['tuần này', 'tuần sau', 'tuần sau nữa'];
    const { weekdayShort } = getLocalDateParts(now, timezone);
    const daysFromMonday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayShort);
    for (let i = 0; i < 15; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const p = getLocalDateParts(d, timezone);
      const iso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      const label = labels[i] ? ` (${labels[i]})` : '';
      const week = weekLabels[Math.floor((Math.max(daysFromMonday, 0) + i) / 7)];
      rows.push(`- ${iso}: ${getVietnameseDayOfWeek(d, timezone)} [${week}]${label}`);
    }
    return rows.join('\n');
  }

  /**
   * Returns list of models to try in order: primary model followed by resilient Gemini 3 fallbacks.
   */
  private getCandidateModels(): string[] {
    const list = [this.model];
    const fallbacks = ['gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-flash-lite-latest'];
    for (const fb of fallbacks) {
      if (!list.includes(fb)) {
        list.push(fb);
      }
    }
    return list;
  }

  /**
   * Parses natural language input by prioritizing Google Gemini Flash API with Structured Outputs first,
   * and falling back to the local deterministic regex parser if Gemini API is unconfigured or fails.
   */
  async parseUserPrompt(
    text: string,
    timezone: string = DEFAULT_TZ
  ): Promise<NlpExtractedTask> {
    const now = new Date();
    const currentIso = getNowWithTimezone(now, timezone);
    const dayOfWeek = getVietnameseDayOfWeek(now, timezone);
    const tzOffset = currentIso.match(/([+-]\d{2}:\d{2})$/)?.[1] || '+07:00';

    // 1. If no Gemini API key is configured, log clearly and use local deterministic regex parser
    if (!this.apiKey) {
      console.warn(
        `[NLP-DEBUG] ⚠️ GEMINI_API_KEY is NOT CONFIGURED or EMPTY! Bypassing Gemini and using local Regex parser.`
      );
      const fallback = this.heuristicFallback(text, currentIso);
      fallback.debug = {
        source: 'REGEX_NO_API_KEY',
        model: this.model,
        apiKeyConfigured: false,
        error: 'Chưa cài đặt GEMINI_API_KEY trong Cloudflare Workers Secrets',
      };
      return fallback;
    }

    // 2. PRIMARY: Call Google Gemini API with Structured Outputs
    const systemPrompt = this.getSystemPrompt(currentIso, dayOfWeek, timezone, tzOffset, now);
    const modelsToTry = this.getCandidateModels();

    const startOverall = Date.now();
    let lastError: string | undefined;

    for (const modelToUse of modelsToTry) {
      // Total NLP budget: Telegram retries webhooks that take too long, which would create duplicate tasks
      if (modelToUse !== modelsToTry[0] && Date.now() - startOverall > NLP_TOTAL_BUDGET_MS) {
        lastError = `${lastError ?? 'Gemini slow'} (đã vượt ${NLP_TOTAL_BUDGET_MS / 1000}s tổng thời gian chờ)`;
        break;
      }
      try {
        console.log(`[NLP-DEBUG] 🚀 Calling Gemini API (model: ${modelToUse}) for: "${text}"`);
        const startTime = Date.now();
        const timeoutMs = NLP_MODEL_TIMEOUT_MS;

        const res = await this.requestGemini(modelToUse, text, systemPrompt, timeoutMs);

        const callDuration = Date.now() - startTime;

        if (!res.ok) {
          lastError =
            res.status === 0
              ? `The operation was aborted due to timeout (${timeoutMs}ms)`
              : res.status === 429
              ? `HTTP 429 Quota Exceeded (giới hạn lượt gọi model ${modelToUse})`
              : res.status === 503
              ? `HTTP 503 High Demand (model ${modelToUse} đang quá tải trên Google AI)`
              : `HTTP ${res.status}: ${res.error}`;
          console.warn(`[NLP-DEBUG] ⚠️ Gemini model ${modelToUse} failed (status: ${res.status}, ${callDuration}ms: ${lastError}). Trying fallback model...`);
          if (res.status === 401) {
            break; // Stop immediately only if API key itself is unauthenticated
          }
          continue;
        }

        // Extract JSON string from response candidates (handling thought parts and markdown fences)
        const rawJson = this.extractJsonFromCandidate(res.data?.candidates?.[0]);
        if (!rawJson) {
          lastError = 'Gemini returned response without valid JSON payload';
          console.warn(`[NLP-DEBUG] ⚠️ Gemini model ${modelToUse} returned no valid JSON part (${callDuration}ms), raw response:`, JSON.stringify(res.data));
          continue;
        }

        const parsed = JSON.parse(rawJson) as NlpExtractedTask;
        const sanitized = this.sanitizeGeminiOutput(parsed, text, currentIso, timezone);
        sanitized.debug = {
          source: 'GEMINI',
          model: modelToUse,
          latency_ms: callDuration,
          apiKeyConfigured: true,
        };
        console.log(`[NLP-DEBUG] ✅ Successfully parsed task using Gemini API (${modelToUse}, ${callDuration}ms): "${sanitized.title}" [${sanitized.intent}]`);
        return sanitized;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[NLP-DEBUG] ❌ Error parsing response from Gemini model ${modelToUse}:`, err);
        continue;
      }
    }

    console.warn(`[NLP-DEBUG] ⚠️ Falling back to local regex parser for: "${text}" (Reason: ${lastError || 'Unknown'})`);
    const fallback = this.heuristicFallback(text, currentIso);
    fallback.debug = {
      source: 'REGEX_FALLBACK',
      model: this.model,
      latency_ms: Date.now() - startOverall,
      apiKeyConfigured: true,
      error: lastError || 'Gemini API call failed',
    };
    return fallback;
  }

  /**
   * Diagnostic trace helper for /debug command and /api/debug/nlp endpoint.
   */
  async parseWithDetailedTrace(
    text: string,
    timezone: string = DEFAULT_TZ
  ): Promise<{
    text: string;
    apiKeyStatus: { configured: boolean; preview?: string; length?: number };
    modelConfigured: string;
    attempts: Array<{
      model: string;
      status: number;
      durationMs: number;
      error?: string;
      rawSnippet?: string;
    }>;
    result: NlpExtractedTask;
    source: 'GEMINI' | 'REGEX_FALLBACK' | 'REGEX_NO_API_KEY';
  }> {
    const attempts: Array<{
      model: string;
      status: number;
      durationMs: number;
      error?: string;
      rawSnippet?: string;
    }> = [];

    const apiKeyStatus = this.getApiKeyStatus();
    const now = new Date();
    const currentIso = getNowWithTimezone(now, timezone);
    const dayOfWeek = getVietnameseDayOfWeek(now, timezone);
    const tzOffset = currentIso.match(/([+-]\d{2}:\d{2})$/)?.[1] || '+07:00';

    if (!this.apiKey) {
      const fallback = this.heuristicFallback(text, currentIso);
      fallback.debug = {
        source: 'REGEX_NO_API_KEY',
        model: this.model,
        apiKeyConfigured: false,
        error: 'Chưa cài đặt GEMINI_API_KEY trong Cloudflare Workers Secrets',
      };
      return {
        text,
        apiKeyStatus,
        modelConfigured: this.model,
        attempts,
        result: fallback,
        source: 'REGEX_NO_API_KEY',
      };
    }

    const systemPrompt = this.getSystemPrompt(currentIso, dayOfWeek, timezone, tzOffset, now);
    const modelsToTry = this.getCandidateModels();

    let finalResult: NlpExtractedTask | null = null;
    let finalSource: 'GEMINI' | 'REGEX_FALLBACK' | 'REGEX_NO_API_KEY' = 'REGEX_FALLBACK';

    for (const modelToUse of modelsToTry) {
      const start = Date.now();
      const timeoutMs = NLP_MODEL_TIMEOUT_MS;
      const res = await this.requestGemini(modelToUse, text, systemPrompt, timeoutMs);
      const dur = Date.now() - start;

      const rawJson = this.extractJsonFromCandidate(res.data?.candidates?.[0]);

      let errorMsg = res.error;
      if (!res.ok) {
        errorMsg =
          res.status === 0
            ? `The operation was aborted due to timeout (${timeoutMs}ms)`
            : res.status === 429
            ? `HTTP 429 Quota Exceeded (hết quota free tier của model này)`
            : res.status === 503
            ? `HTTP 503 High Demand (Google AI đang quá tải)`
            : res.error;
      }

      attempts.push({
        model: modelToUse,
        status: res.status,
        durationMs: dur,
        error: errorMsg,
        rawSnippet: rawJson ? rawJson.slice(0, 300) : (errorMsg?.slice(0, 300) || JSON.stringify(res.data)?.slice(0, 300)),
      });

      if (res.ok && rawJson) {
        try {
          const parsed = JSON.parse(rawJson) as NlpExtractedTask;
          finalResult = this.sanitizeGeminiOutput(parsed, text, currentIso, timezone);
          finalResult.debug = {
            source: 'GEMINI',
            model: modelToUse,
            latency_ms: dur,
            apiKeyConfigured: true,
          };
          finalSource = 'GEMINI';
          break;
        } catch {}
      }

      if (!res.ok) {
        if (res.status === 401) {
          break;
        }
        continue;
      }
      break;
    }

    if (!finalResult) {
      finalResult = this.heuristicFallback(text, currentIso);
      finalResult.debug = {
        source: 'REGEX_FALLBACK',
        model: this.model,
        apiKeyConfigured: true,
        error: attempts[0]?.error || 'Gemini call failed',
      };
      finalSource = 'REGEX_FALLBACK';
    }

    return {
      text,
      apiKeyStatus,
      modelConfigured: this.model,
      attempts,
      result: finalResult,
      source: finalSource,
    };
  }

  /**
   * Low-level fetch wrapper for Google Gemini REST API.
   */
  private async requestGemini(
    model: string,
    text: string,
    systemPrompt: string,
    timeoutMs = 12000
  ): Promise<{ ok: boolean; status: number; error?: string; data?: GeminiGenerateResponse }> {
    const cleanModel = model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${encodeURIComponent(this.apiKey || '')}`;

    const generationConfig: Record<string, unknown> = {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_JSON_SCHEMA,
      temperature: 0,
    };

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
      generationConfig,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey || '',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { ok: false, status: response.status, error: errorText };
      }

      const data = (await response.json()) as GeminiGenerateResponse;
      return { ok: true, status: response.status, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Robustly extracts JSON string from a candidate's content parts.
   * Handles cases where parts contain internal thoughts (thought: true),
   * markdown code fences, or leading/trailing text.
   */
  private extractJsonFromCandidate(candidate?: GeminiCandidate): string | null {
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) return null;

    // 1. Look for parts explicitly not marked as internal thought
    const nonThoughtParts = parts.filter(
      (p) => !p.thought && typeof p.text === 'string' && p.text.trim().length > 0
    );

    for (const part of nonThoughtParts) {
      const extracted = this.extractJsonString(part.text!);
      if (this.isValidJson(extracted)) {
        return extracted;
      }
    }

    // 2. Fallback: inspect all parts from last to first
    for (let i = parts.length - 1; i >= 0; i--) {
      const text = parts[i]?.text;
      if (text) {
        const extracted = this.extractJsonString(text);
        if (this.isValidJson(extracted)) {
          return extracted;
        }
      }
    }

    return null;
  }

  /**
   * Strips markdown fences (```json ... ```) and extracts outermost JSON object { ... }.
   */
  private extractJsonString(raw: string): string {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
    return cleaned;
  }

  /**
   * Checks if string is parseable JSON object.
   */
  private isValidJson(str: string): boolean {
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  }

  /**
   * Sanitizes output parsed from Gemini to guarantee safe defaults and non-empty title.
   */
  private sanitizeGeminiOutput(
    parsed: NlpExtractedTask,
    text: string,
    currentIso: string,
    timezone: string = DEFAULT_TZ
  ): NlpExtractedTask {
    if (parsed.intent === 'UNKNOWN') {
      const fastFallback = this.fastPatternParse(text, currentIso);
      if (fastFallback) {
        return fastFallback;
      }
      return parsed;
    }

    if (parsed.intent === 'CREATE_TASK') {
      const isCritical = CRITICAL_RE.test(text);

      if (!parsed.title || !parsed.title.trim()) {
        parsed.title = this.buildCleanTitle(text) || text;
      } else {
        // Models sometimes wrap the title in quotes
        parsed.title = parsed.title.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim() || this.buildCleanTitle(text) || text;
      }

      // Detect and eliminate model reasoning leakage (e.g. Chinese thought text, nested JSON, prompt echoes)
      const hasChinese = /[\u4e00-\u9fa5]/.test(parsed.title);
      // Also catches date/time debris such as "Họp (20-06T:00+) họp"
      const hasJsonOrNotes =
        /->\s*\{|\{"title"|Title:|Due:|\(Note:/i.test(parsed.title) ||
        /\([^)]*\d[^)]*\)|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}T|T\d{2}:?\d{2}/.test(parsed.title);
      if (hasChinese || hasJsonOrNotes || (parsed.title.length > 80 && text.length < 50)) {
        console.warn(`[NLP-DEBUG] ⚠️ Detected reasoning leakage in title ("${parsed.title}"). Cleaning...`);
        // Try to extract from nested JSON if model dumped JSON inside title
        const innerJsonMatch = parsed.title.match(/\{[\s\S]*"title"\s*:\s*"([^"\\]+)"[\s\S]*\}/);
        const innerDueMatch = parsed.title.match(/"due_at_iso"\s*:\s*"([^"]+)"/);
        if (innerDueMatch && !parsed.due_at_iso) {
          parsed.due_at_iso = innerDueMatch[1];
        }

        if (innerJsonMatch) {
          parsed.title = innerJsonMatch[1].trim();
        } else {
          const titleMatch = parsed.title.match(/Title:\s*([^.\n,]+)/i);
          if (titleMatch) {
            parsed.title = titleMatch[1].trim();
          } else {
            parsed.title = this.buildCleanTitle(text) || text;
          }
        }
      }

      // Only clean when time phrases actually leaked into the title; otherwise trust the model
      // (aggressive cleaning would eat "2 phòng ban", names like "anh Mai", etc.)
      if (TIME_RESIDUE_RE.test(parsed.title)) {
        const cleanedTitle = this.buildCleanTitle(parsed.title);
        if (cleanedTitle && cleanedTitle.length >= 2) {
          parsed.title = cleanedTitle;
        }
      }

      if (parsed.title) {
        parsed.title = parsed.title.charAt(0).toUpperCase() + parsed.title.slice(1);
      }

      // Validate model-provided due date; an unparseable value is treated as missing
      if (parsed.due_at_iso && isNaN(new Date(parsed.due_at_iso).getTime())) {
        parsed.due_at_iso = null;
      }

      if (!parsed.due_at_iso) {
        const regexTask = this.fastPatternParse(text, currentIso);
        if (regexTask?.due_at_iso) {
          parsed.due_at_iso = regexTask.due_at_iso;
          if (parsed.remind_before_minutes === undefined || parsed.remind_before_minutes === null) {
            parsed.remind_before_minutes = regexTask.remind_before_minutes;
          }
        } else {
          // No time information at all: flag it so the bot can tell the user instead of guessing silently
          parsed.due_at_iso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          parsed.time_assumed = true;
        }
      } else if (WEEK_RELATIVE_DATE_RE.test(text)) {
        // Models confuse "thứ 6 tuần sau" with the nearest Friday (esp. early in the week);
        // the regex parser computes the calendar date exactly, so keep the model's clock time on that date.
        parsed.due_at_iso = this.alignDateWithRegex(parsed.due_at_iso, text, currentIso, timezone);
      }

      if (parsed.recurrence_rrule && !VALID_RRULE_RE.test(parsed.recurrence_rrule.trim().toUpperCase())) {
        parsed.recurrence_rrule = null;
      } else if (parsed.recurrence_rrule) {
        parsed.recurrence_rrule = parsed.recurrence_rrule.trim().toUpperCase();
      }

      // Weaker models sometimes drop the recurrence; explicit phrases ("hàng tuần", "mỗi ngày") are
      // reliably detectable, so recover rule and first occurrence from the deterministic parser.
      if (!parsed.recurrence_rrule) {
        const rx = this.fastPatternParse(text, currentIso);
        if (rx?.recurrence_rrule) {
          parsed.recurrence_rrule = rx.recurrence_rrule;
          if (rx.due_at_iso) parsed.due_at_iso = rx.due_at_iso;
        }
      }

      // A recurring task's first occurrence must be in the future (e.g. "thứ 2 hàng tuần 6h" said on Monday 8h)
      if (parsed.recurrence_rrule && parsed.due_at_iso) {
        const dueMs = new Date(parsed.due_at_iso).getTime();
        if (!isNaN(dueMs) && dueMs <= Date.now()) {
          try {
            parsed.due_at_iso = calculateNextRecurrence(
              parsed.due_at_iso,
              parsed.due_at_iso,
              parsed.recurrence_rrule,
              timezone
            ).dueAt;
          } catch {
            // keep model value; webhook rejects past times
          }
        }
      }

      if (!parsed.priority) {
        parsed.priority = isCritical ? 'CRITICAL' : 'MEDIUM';
      }

      if (parsed.nagging_mode === undefined || parsed.nagging_mode === null) {
        parsed.nagging_mode = isCritical || parsed.priority === 'CRITICAL';
      }

      if (parsed.remind_before_minutes === undefined || parsed.remind_before_minutes === null) {
        parsed.remind_before_minutes = 0;
      }
    }

    return parsed;
  }

  /**
   * Moves a model-provided due time onto the calendar date resolved by the deterministic parser,
   * preserving the model's local time of day. Returns the input unchanged if the parser finds no date.
   */
  private alignDateWithRegex(
    dueIso: string,
    text: string,
    currentIso: string,
    timezone: string
  ): string {
    const regexDue = this.fastPatternParse(text, currentIso)?.due_at_iso;
    if (!regexDue) return dueIso;
    const model = getLocalDateParts(new Date(dueIso), timezone);
    const target = getLocalDateParts(new Date(regexDue), timezone);
    const dayDiff = Math.round(
      (Date.UTC(target.year, target.month - 1, target.day) -
        Date.UTC(model.year, model.month - 1, model.day)) /
        (24 * 60 * 60 * 1000)
    );
    if (dayDiff === 0) return dueIso;
    console.warn(`[NLP-DEBUG] ⚠️ Correcting model date ${dueIso} by ${dayDiff} day(s) to match "${text}"`);
    return getNowWithTimezone(new Date(new Date(dueIso).getTime() + dayDiff * 24 * 60 * 60 * 1000), timezone);
  }

  /**
   * Deterministic fallback when Gemini API is unavailable, times out, or has no API key.
   */
  private heuristicFallback(text: string, currentIso: string): NlpExtractedTask {
    const isCritical = CRITICAL_RE.test(text);
    return (
      this.fastPatternParse(text, currentIso) || {
        intent: 'CREATE_TASK',
        title: this.buildCleanTitle(text) || text,
        due_at_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        remind_before_minutes: 0,
        priority: isCritical ? 'CRITICAL' : 'MEDIUM',
        nagging_mode: isCritical,
        recurrence_rrule: null,
        time_assumed: true,
      }
    );
  }

  /**
   * Deterministic regex parser for common Vietnamese time/task phrases.
   * Used as fallback when Gemini API is unavailable or unconfigured.
   */
  private fastPatternParse(
    text: string,
    currentIso: string
  ): NlpExtractedTask | null {
    const lower = text.toLowerCase().trim();

    // 1. Intent detection: only match LIST_TASKS or CANCEL_TASK when not part of a task creation sentence
    const hasTaskCreationTimeIndicators =
      /\b(?:nhắc|lúc|\d{1,2}\s*(?:h|giờ|phút|p|tiếng)|sáng|trưa|chiều|tối|mai|mốt|ngày\s+kia|hàng\s+tháng|mỗi\s+ngày|hàng\s+tuần)\b/i.test(
        lower
      );

    if (
      !hasTaskCreationTimeIndicators &&
      /(?:^\/list\b|^(?:cho\s+(?:tôi|mình|em)\s+)?xem\s+(?:danh\s+sách|công\s+việc|việc)|^danh\s+sách\s*(?:công\s+việc|việc|nhắc\s+nhở)?$|^list(?:\s+tasks?)?$)/i.test(
        lower
      )
    ) {
      return { intent: 'LIST_TASKS' };
    }

    if (
      !hasTaskCreationTimeIndicators &&
      /^(?:hủy|xóa|bỏ)\s+(?:công\s+việc|nhắc\s+nhở|task|việc)\b/i.test(lower)
    ) {
      return { intent: 'CANCEL_TASK' };
    }

    // Extract explicit remind_before_minutes if user specified "nhắc trước X phút" / "báo trước Xp"
    let explicitRemindBefore: number | null = null;
    const remindBeforeMatch = lower.match(/(?:nhắc|báo)\s+trước\s+(\d+)\s*(?:phút|p)/);
    if (remindBeforeMatch) {
      explicitRemindBefore = parseInt(remindBeforeMatch[1], 10);
    }

    const isCritical = CRITICAL_RE.test(lower);
    const priority = isCritical ? 'CRITICAL' : 'MEDIUM';

    // Parse base date, current clock time & tz offset from currentIso (e.g. "2026-10-22T10:30:00+07:00")
    const [datePart, timePartWithTz] = currentIso.split('T');
    const todayStr = datePart; // "2026-10-22"
    const tzOffset = currentIso.match(/([+-]\d{2}:\d{2})$/)?.[1] || '+07:00';
    const [curHStr, curMStr] = (timePartWithTz || '00:00:00').split(':');
    const currentHour = parseInt(curHStr || '0', 10);
    const currentMinute = parseInt(curMStr || '0', 10);

    // ================================================================
    // STEP 1: Recurring patterns (e.g. "ngày 4 hàng tháng", "mỗi ngày")
    // ================================================================
    const recurResult = this.parseRecurringPattern(
      lower,
      text,
      todayStr,
      currentHour,
      currentMinute,
      tzOffset,
      priority,
      isCritical,
      explicitRemindBefore
    );
    if (recurResult) {
      return recurResult;
    }

    // Clean out "nhắc trước X phút" before parsing due time so it doesn't get confused with relative due time
    const lowerWithoutRemindBefore = lower.replace(/(?:nhắc|báo)\s+trước\s+\d+\s*(?:phút|p)/g, '');

    // ================================================================
    // STEP 2: Absolute time WITH period
    // Case A: Hour then period (e.g. "4h30 chiều", "5h chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "11h trưa")
    // Case B: Period then hour (e.g. "chiều 5h", "chiều 5h30", "chiều 5 rưỡi", "tối 8h", "sáng 7h", "trưa 11h30")
    // ================================================================
    const timeWithPeriod = lowerWithoutRemindBefore.match(
      /(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?\s*(sáng|trưa|chiều|tối)/
    );
    const periodWithTime = lowerWithoutRemindBefore.match(
      /\b(sáng|trưa|chiều|tối)\s+(?:lúc\s+)?(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?(?!\p{L})/u
    );

    // "9h kém 15" = 08:45
    const kemMatch = lowerWithoutRemindBefore.match(/(\d{1,2})\s*(?:h|giờ)\s*kém\s*(\d{1,2})/);

    let targetHour: number | null = null;
    let targetMinute = 0;
    let matchedAbsoluteTime = false;

    if (kemMatch && parseInt(kemMatch[1], 10) >= 1 && parseInt(kemMatch[2], 10) >= 1 && parseInt(kemMatch[2], 10) < 60) {
      let h = parseInt(kemMatch[1], 10) - 1;
      if (/chiều|tối/.test(lowerWithoutRemindBefore) && h < 12) h += 12;
      targetHour = h;
      targetMinute = 60 - parseInt(kemMatch[2], 10);
      matchedAbsoluteTime = true;
    } else if (timeWithPeriod) {
      const h = parseInt(timeWithPeriod[1], 10);
      if (h >= 1 && h <= 12) {
        const capturedMin = timeWithPeriod[2];
        const isRuoi = !!timeWithPeriod[3];
        const period = timeWithPeriod[4];

        const parsedMin = capturedMin ? parseInt(capturedMin, 10) : isRuoi ? 30 : 0;
        if (parsedMin >= 0 && parsedMin <= 59) {
          targetMinute = parsedMin;
          if (period === 'chiều' || period === 'tối') {
            targetHour = h < 12 ? h + 12 : h;
          } else if (period === 'sáng' && h === 12) {
            targetHour = 0;
          } else if (period === 'trưa' && h < 11) {
            targetHour = h + 12;
          } else {
            targetHour = h;
          }
          matchedAbsoluteTime = true;
        }
      }
    } else if (periodWithTime) {
      const period = periodWithTime[1];
      const h = parseInt(periodWithTime[2], 10);
      if (h >= 1 && h <= 12) {
        const capturedMin = periodWithTime[3];
        const isRuoi = !!periodWithTime[4];
        const parsedMin = capturedMin ? parseInt(capturedMin, 10) : isRuoi ? 30 : 0;
        if (parsedMin >= 0 && parsedMin <= 59) {
          targetMinute = parsedMin;
          if (period === 'chiều' || period === 'tối') {
            targetHour = h < 12 ? h + 12 : h;
          } else if (period === 'sáng' && h === 12) {
            targetHour = 0;
          } else if (period === 'trưa' && h < 11) {
            targetHour = h + 12;
          } else {
            targetHour = h;
          }
          matchedAbsoluteTime = true;
        }
      }
    }

    // ================================================================
    // STEP 3: Relative time (e.g. "10p nữa", "sau 15 phút", "trong 2 tiếng nữa", "nửa tiếng nữa")
    // ================================================================
    let relDayOffset: number | null = null;
    if (!matchedAbsoluteTime) {
      const lw = lowerWithoutRemindBefore;
      // Require "sau/trong N" or "N ... nữa" so "tuần sau 9h" is never read as "in 9 hours"
      const relMinMatch = lw.match(
        /(?:(?:(?<!(?:tuần|tháng|năm)\s)sau|trong)\s+(\d+)\s*(?:phút|p)(?!\p{L})|(\d+)\s*(?:phút|p)(?!\p{L})\s*nữa|nhắc\s+(?:tôi\s+|mình\s+|em\s+)?(\d+)\s*(?:phút|p)(?!\p{L}))/u
      );
      const relHourMatch = lw.match(
        /(?:(?:(?<!(?:tuần|tháng|năm)\s)sau|trong)\s+(\d+)\s*(?:tiếng|giờ|h)(?!\p{L})|(\d+)\s*(?:tiếng|giờ|h)(?!\p{L})\s*nữa)/u
      );
      const relDayMatch = lw.match(/(?:(?:(?<!(?:tuần|tháng|năm)\s)sau|trong)\s+(\d+)\s*ngày(?!\p{L})|(\d+)\s*ngày\s*nữa)/u);
      const isHalfHour = /nửa\s+(?:tiếng|giờ)/.test(lw);

      let minutesToAdd = 0;
      if (isHalfHour) {
        minutesToAdd = 30;
      } else if (relMinMatch) {
        minutesToAdd = parseInt(relMinMatch[1] ?? relMinMatch[2] ?? relMinMatch[3], 10);
      } else if (relHourMatch) {
        minutesToAdd = parseInt(relHourMatch[1] ?? relHourMatch[2], 10) * 60;
      } else if (relDayMatch) {
        relDayOffset = parseInt(relDayMatch[1] ?? relDayMatch[2], 10);
      }

      if (minutesToAdd > 0) {
        const dueDate = new Date(Date.now() + minutesToAdd * 60 * 1000);
        const cleanTitle = this.buildCleanTitle(text);

        return {
          intent: 'CREATE_TASK',
          title: cleanTitle || text,
          due_at_iso: dueDate.toISOString(),
          remind_before_minutes: explicitRemindBefore ?? 0,
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
        lowerWithoutRemindBefore.match(/(?<!\p{L})(sáng|trưa|chiều|tối)\s*(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)(?!\p{L})/u) ||
        lowerWithoutRemindBefore.match(/(?<!\p{L})(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\s+(sáng|trưa|chiều|tối)(?!\p{L})/u);

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
      const time24Match = lowerWithoutRemindBefore.match(
        /(?:lúc\s+)?(\d{1,2})\s*(?:h|giờ|:)\s*(\d{1,2})?(?!\p{L})/u
      );
      if (time24Match) {
        const h = parseInt(time24Match[1], 10);
        const m = time24Match[2] ? parseInt(time24Match[2], 10) : 0;
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          targetHour = h;
          targetMinute = m;
          matchedAbsoluteTime = true;
        }
      }
    }

    // ================================================================
    // STEP 6: Combine extracted time and date (explicit DD/MM, weekday, or relative day offset)
    // ================================================================
    const [baseY, baseM, baseD] = todayStr.split('-').map(Number);

    // Check for explicit date: "ngày 20 tháng 12", "ngày 20/12", "20/12/2026", etc.
    const explicitDateMatch = lowerWithoutRemindBefore.match(
      /(?:ngày\s+)?(\d{1,2})\s*(?:tháng|thg|\/|\-)\s*(\d{1,2})(?:\s*(?:năm|\/|\-)\s*(\d{4}))?(?!\d)/
    );

    // Check for standalone weekday: "thứ 6", "thứ sáu tuần sau", "chủ nhật"
    const weekdayMatch = lowerWithoutRemindBefore.match(
      /(?:(thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\s*nhật))(?:\s+(tuần\s+(?:sau|tới|này)))?/
    );

    const dayAfter = DAY_AFTER_RE.test(lowerWithoutRemindBefore);
    const tomorrow = TOMORROW_RE.test(lowerWithoutRemindBefore);
    const todayWord = TODAY_RE.test(lowerWithoutRemindBefore);
    const nextMonday = /đầu\s+tuần\s+(?:sau|tới)/.test(lowerWithoutRemindBefore);
    const weekendWord = /cuối\s+tuần(?!\s+(?:sau|tới))/.test(lowerWithoutRemindBefore);
    const endOfMonth = /cuối\s+tháng/.test(lowerWithoutRemindBefore);
    const nextWeekOnly = !weekdayMatch && /tuần\s+(?:sau|tới)/.test(lowerWithoutRemindBefore);
    const hasDateHint =
      !!explicitDateMatch || !!weekdayMatch || dayAfter || tomorrow || todayWord ||
      nextMonday || weekendWord || endOfMonth || nextWeekOnly || relDayOffset !== null;

    // A date with no clock time defaults to 09:00 (or the period default, e.g. "tối" = 20:00)
    if (targetHour === null && hasDateHint) {
      const extracted = this.extractTimeFromText(lowerWithoutRemindBefore);
      targetHour = extracted.hour;
      targetMinute = extracted.minute;
    }

    if (targetHour !== null) {
      let yy = baseY;
      let mmNum = baseM;
      let ddNum = baseD;

      if (explicitDateMatch) {
        const parsedDay = parseInt(explicitDateMatch[1], 10);
        const parsedMonth = parseInt(explicitDateMatch[2], 10);
        const parsedYear = explicitDateMatch[3] ? parseInt(explicitDateMatch[3], 10) : baseY;

        if (parsedMonth >= 1 && parsedMonth <= 12 && parsedDay >= 1 && parsedDay <= getDaysInMonth(parsedYear, parsedMonth)) {
          yy = parsedYear;
          mmNum = parsedMonth;
          ddNum = parsedDay;
          if (!explicitDateMatch[3]) {
            const candidate = new Date(Date.UTC(yy, mmNum - 1, ddNum));
            const todayUtc = new Date(Date.UTC(baseY, baseM - 1, baseD));
            if (candidate.getTime() < todayUtc.getTime()) {
              yy += 1;
            }
          }
        }
      } else if (weekdayMatch) {
        const rawDay = weekdayMatch[1].replace(/\s+/g, ' ');
        const isNextWeek = !!weekdayMatch[2] && /(?:sau|tới)/.test(weekdayMatch[2]);
        const weekdayMap: Record<string, number> = {
          'chủ nhật': 0,
          'chủnhật': 0,
          'thứ hai': 1, 'thứ 2': 1,
          'thứ ba': 2, 'thứ 3': 2,
          'thứ tư': 3, 'thứ 4': 3,
          'thứ năm': 4, 'thứ 5': 4,
          'thứ sáu': 5, 'thứ 6': 5,
          'thứ bảy': 6, 'thứ 7': 6,
        };
        const targetWeekday = weekdayMap[rawDay] ?? 1;
        const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
        const currentWeekday = todayDate.getUTCDay();

        let daysUntil: number;
        if (isNextWeek) {
          // Calculate Monday of next week (ISO week starts Monday)
          const daysFromMonday = (currentWeekday + 6) % 7;
          const daysToNextMonday = 7 - daysFromMonday;
          const targetOffsetFromMonday = (targetWeekday + 6) % 7;
          daysUntil = daysToNextMonday + targetOffsetFromMonday;
        } else {
          daysUntil = targetWeekday - currentWeekday;
          const timeAlreadyPassedToday =
            targetHour < currentHour || (targetHour === currentHour && targetMinute <= currentMinute);
          if (daysUntil < 0 || (daysUntil === 0 && timeAlreadyPassedToday)) {
            daysUntil += 7;
          }
        }

        const targetDate = new Date(Date.UTC(baseY, baseM - 1, baseD + daysUntil));
        yy = targetDate.getUTCFullYear();
        mmNum = targetDate.getUTCMonth() + 1;
        ddNum = targetDate.getUTCDate();
      } else {
        let dayOffset = 0;
        const hasExplicitToday = todayWord;
        const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
        const currentWeekday = todayDate.getUTCDay();
        if (relDayOffset !== null) {
          dayOffset = relDayOffset;
        } else if (dayAfter) {
          dayOffset = 2;
        } else if (tomorrow) {
          dayOffset = 1;
        } else if (nextMonday) {
          dayOffset = 7 - ((currentWeekday + 6) % 7);
        } else if (nextWeekOnly) {
          dayOffset = 7;
        } else if (weekendWord) {
          dayOffset = (6 - currentWeekday + 7) % 7;
        } else if (endOfMonth) {
          dayOffset = getDaysInMonth(baseY, baseM) - baseD;
        } else if (!hasExplicitToday && !hasDateHint) {
          // If no date word was specified and the target time has already passed today, schedule for tomorrow
          const timeAlreadyPassedToday =
            targetHour < currentHour || (targetHour === currentHour && targetMinute <= currentMinute);
          if (timeAlreadyPassedToday) {
            dayOffset = 1;
          }
        }

        const targetDate = new Date(Date.UTC(baseY, baseM - 1, baseD + dayOffset));
        yy = targetDate.getUTCFullYear();
        mmNum = targetDate.getUTCMonth() + 1;
        ddNum = targetDate.getUTCDate();
      }

      const mm = mmNum.toString().padStart(2, '0');
      const dd = ddNum.toString().padStart(2, '0');
      const hh = targetHour.toString().padStart(2, '0');
      const mi = targetMinute.toString().padStart(2, '0');
      const localIso = `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`;

      const cleanTitle = this.buildCleanTitle(text);

      return {
        intent: 'CREATE_TASK',
        title: cleanTitle || text,
        due_at_iso: localIso,
        remind_before_minutes: explicitRemindBefore ?? 0,
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
    currentHour: number,
    currentMinute: number,
    tzOffset: string,
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    isCritical: boolean,
    explicitRemindBefore: number | null
  ): NlpExtractedTask | null {
    const [baseY, baseM, baseD] = todayStr.split('-').map(Number);

    // --- "ngày X hàng tháng" / "ngày X mỗi tháng" / "mỗi tháng ngày X" ---
    const monthlyMatch =
      lower.match(/ngày\s+(\d{1,2})\s+(?:hàng|mỗi)\s+tháng/) ||
      lower.match(/(?:hàng|mỗi)\s+tháng\s+(?:vào\s+)?ngày\s+(\d{1,2})/);
    if (monthlyMatch) {
      const dayOfMonth = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        let targetMonth = baseM;
        let targetYear = baseY;
        const { hour, minute } = this.extractTimeFromText(lower);

        const timeAlreadyPassedToday =
          hour < currentHour || (hour === currentHour && minute <= currentMinute);

        // Move to next month if today is past dayOfMonth, OR if today is dayOfMonth and target time has passed
        if (baseD > dayOfMonth || (baseD === dayOfMonth && timeAlreadyPassedToday)) {
          targetMonth++;
          if (targetMonth > 12) {
            targetMonth = 1;
            targetYear++;
          }
        }

        // Clamp day to actual number of days in targetMonth (e.g. Nov 31 -> Nov 30)
        const clampedDay = Math.min(dayOfMonth, getDaysInMonth(targetYear, targetMonth));
        const mm = targetMonth.toString().padStart(2, '0');
        const dd = clampedDay.toString().padStart(2, '0');
        const hh = hour.toString().padStart(2, '0');
        const mi = minute.toString().padStart(2, '0');
        const cleanTitle = this.buildCleanTitle(originalText);

        return {
          intent: 'CREATE_TASK',
          title: cleanTitle || originalText,
          due_at_iso: `${targetYear}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
          remind_before_minutes: explicitRemindBefore ?? 0,
          priority,
          nagging_mode: isCritical,
          recurrence_rrule: `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth}`,
        };
      }
    }

    // --- "mỗi ngày" / "hàng ngày" ---
    if (/(?:mỗi|hàng)\s+ngày/.test(lower)) {
      const { hour, minute } = this.extractTimeFromText(lower);
      const timeAlreadyPassedToday =
        hour < currentHour || (hour === currentHour && minute <= currentMinute);
      const dayOffset = timeAlreadyPassedToday ? 1 : 0;

      const firstDate = new Date(Date.UTC(baseY, baseM - 1, baseD + dayOffset));
      const yy = firstDate.getUTCFullYear();
      const mm = (firstDate.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = firstDate.getUTCDate().toString().padStart(2, '0');
      const hh = hour.toString().padStart(2, '0');
      const mi = minute.toString().padStart(2, '0');
      const cleanTitle = this.buildCleanTitle(originalText);

      return {
        intent: 'CREATE_TASK',
        title: cleanTitle || originalText,
        due_at_iso: `${yy}-${mm}-${dd}T${hh}:${mi}:00${tzOffset}`,
        remind_before_minutes: explicitRemindBefore ?? 0,
        priority,
        nagging_mode: isCritical,
        recurrence_rrule: 'FREQ=DAILY',
      };
    }

    // --- "thứ X hàng tuần", "thứ 2 và thứ 4 hàng tuần", "mỗi thứ 6", "chủ nhật hàng tuần" ---
    if (/(?:hàng|mỗi)\s+(?:tuần|thứ|chủ\s*nhật)/.test(lower)) {
      const codeMap: Record<string, string> = {
        hai: 'MO', '2': 'MO', ba: 'TU', '3': 'TU', 'tư': 'WE', '4': 'WE',
        'năm': 'TH', '5': 'TH', 'sáu': 'FR', '6': 'FR', 'bảy': 'SA', '7': 'SA',
      };
      const jsWeekday: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
      const codes: string[] = [];
      for (const m of lower.matchAll(/thứ\s+(hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\s*nhật/g)) {
        const code = m[1] ? codeMap[m[1]] : 'SU';
        if (code && !codes.includes(code)) codes.push(code);
      }

      if (codes.length > 0) {
        const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
        const currentWeekday = todayDate.getUTCDay();
        const { hour, minute } = this.extractTimeFromText(lower);
        const timeAlreadyPassedToday =
          hour < currentHour || (hour === currentHour && minute <= currentMinute);

        // Earliest upcoming occurrence among all requested weekdays
        let daysUntil = Infinity;
        for (const code of codes) {
          let d = jsWeekday[code] - currentWeekday;
          if (d < 0 || (d === 0 && timeAlreadyPassedToday)) d += 7;
          daysUntil = Math.min(daysUntil, d);
        }

        const nextOccurrence = new Date(Date.UTC(baseY, baseM - 1, baseD + daysUntil));
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
          remind_before_minutes: explicitRemindBefore ?? 0,
          priority,
          nagging_mode: isCritical,
          recurrence_rrule: `FREQ=WEEKLY;BYDAY=${codes.join(',')}`,
        };
      }
    }

    return null;
  }

  /**
   * Helper: Extracts time-of-day from text, default to 09:00 if unspecified.
   */
  private extractTimeFromText(lower: string): { hour: number; minute: number } {
    const kem = lower.match(/(\d{1,2})\s*(?:h|giờ)\s*kém\s*(\d{1,2})/);
    if (kem) {
      const kh = parseInt(kem[1], 10) - 1;
      const km = parseInt(kem[2], 10);
      if (kh >= 0 && km >= 1 && km < 60) {
        return { hour: /chiều|tối/.test(lower) && kh < 12 ? kh + 12 : kh, minute: 60 - km };
      }
    }

    const withPeriod = lower.match(
      /(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?\s*(sáng|trưa|chiều|tối)/
    );
    if (withPeriod) {
      let h = parseInt(withPeriod[1], 10);
      if (h >= 1 && h <= 12) {
        const minStr = withPeriod[2];
        const isRuoi = !!withPeriod[3];
        const period = withPeriod[4];
        const m = minStr ? parseInt(minStr, 10) : isRuoi ? 30 : 0;
        if (m >= 0 && m <= 59) {
          if ((period === 'chiều' || period === 'tối') && h < 12) h += 12;
          if (period === 'sáng' && h === 12) h = 0;
          return { hour: h, minute: m };
        }
      }
    }

    const periodWithTime = lower.match(
      /\b(sáng|trưa|chiều|tối)\s+(?:lúc\s+)?(\d{1,2})\s*(?:h|giờ|:)?\s*(\d{1,2})?\s*(rưỡi)?(?!\p{L})/u
    );
    if (periodWithTime) {
      const period = periodWithTime[1];
      let h = parseInt(periodWithTime[2], 10);
      if (h >= 1 && h <= 12) {
        const minStr = periodWithTime[3];
        const isRuoi = !!periodWithTime[4];
        const m = minStr ? parseInt(minStr, 10) : isRuoi ? 30 : 0;
        if (m >= 0 && m <= 59) {
          if ((period === 'chiều' || period === 'tối') && h < 12) h += 12;
          if (period === 'sáng' && h === 12) h = 0;
          if (period === 'trưa' && h < 11) h += 12;
          return { hour: h, minute: m };
        }
      }
    }

    const time24 = lower.match(/(?:lúc\s+)?(\d{1,2})\s*(?:h|giờ|:)\s*(\d{1,2})?(?!\p{L})/u);
    if (time24) {
      const h = parseInt(time24[1], 10);
      const m = time24[2] ? parseInt(time24[2], 10) : 0;
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return { hour: h, minute: m };
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
      // 0. Weekday lists first ("thứ 2 và thứ 4 hàng tuần"), before single "thứ X hàng tuần" eats the tail
      .replace(new RegExp(`(?:${WEEKDAY_SRC})(?:\\s*(?:,|và)\\s*(?:${WEEKDAY_SRC}))+`, 'giu'), '')
      // 1. Remove recurring patterns (before general hours or numbers to avoid "4 hàng" -> "4h")
      .replace(/ngày\s+\d{1,2}\s+(?:hàng|mỗi)\s+tháng/gi, '')
      .replace(/(?:hàng|mỗi)\s+tháng\s+(?:vào\s+)?ngày\s+\d{1,2}/gi, '')
      .replace(/(?:(?:sáng|trưa|chiều|tối)\s+)?thứ\s+(?:\d|hai|ba|tư|năm|sáu|bảy)\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/(?:(?:sáng|trưa|chiều|tối)\s+)?chủ\s*nhật\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/(?:mỗi|hàng)\s+(?:ngày|tuần|tháng)/gi, '')
      // 2. Remove pre-reminder instructions ("nhắc trước 15 phút", "báo trước 30p")
      .replace(/(?:nhắc|báo)\s+trước\s+\d+\s*(?:phút|p)/gi, '')
      // 3. Remove "nhắc tôi/mình/em"
      .replace(/nhắc\s*(?:tôi|mình|em)?\s*/gi, '')
      // 4-pre. "9h kém 15"
      .replace(/\d{1,2}\s*(?:h|giờ)\s*kém\s*\d{1,2}/gi, '')
      // 4A. Remove time + period: "4h30 chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "8 giờ tối"
      .replace(/\d{1,2}\s*(?:h|giờ|:)?\s*\d{0,2}\s*(?:rưỡi)?\s*(?:sáng|trưa|chiều|tối)/gi, '')
      // 4B. Remove period + time: "chiều 5h", "chiều 5h30", "chiều 5 rưỡi", "tối 8h", "sáng 7h"
      .replace(/(?:sáng|trưa|chiều|tối)\s+(?:lúc\s+)?\d{1,2}\s*(?:h|giờ|:)?\s*\d{0,2}\s*(?:rưỡi)?(?!\p{L})/giu, '')
      // 5. Remove standalone weekday (with optional period and week modifier): "Chiều thứ 6", "thứ 6 tuần sau"
      .replace(
        /(?:(?:sáng|trưa|chiều|tối)\s+)?(?:thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\s*nhật)(?:\s+tuần\s+(?:sau|tới|này))?(?:\s+(?:sáng|trưa|chiều|tối))?/gi,
        ''
      )
      // 6. Remove explicit DD/MM(/YYYY) or "ngày D tháng M (năm Y)" dates
      .replace(
        /(?:(?:sáng|trưa|chiều|tối)\s+)?(?:ngày\s+)?\d{1,2}\s*(?:tháng|thg|\/|\-)\s*\d{1,2}(?:\s*(?:năm|\/|\-)\s*\d{4})?(?!\d)/gi,
        ''
      )
      // 7. Remove standalone period + date: "trưa mai", "sáng mai", "chiều nay", "tối mốt"
      .replace(/(?:sáng|trưa|chiều|tối)\s*(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)/gi, '')
      .replace(/(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\s+(?:sáng|trưa|chiều|tối)/gi, '')
      // 8. Remove standalone date words: "hôm nay", "ngày mai", "ngày kia"
      .replace(/\bhôm\s*nay\b/gi, '')
      .replace(/\bngày\s*(?:mai|mốt|kia)\b/gi, '')
      .replace(new RegExp(`${L}${NAME_PREFIX}(?:mai|mốt|nay)${R}`, 'giu'), '')
      .replace(/đầu\s+tuần\s+(?:sau|tới)|cuối\s+tuần|cuối\s+tháng|tuần\s+(?:sau|tới)/gi, '')
      // 10. Remove relative time: "sau 10 phút", "2 tiếng nữa", "nửa tiếng nữa"
      // Require "sau/trong N" or "N ... nữa" so "họp 2 phòng ban" / "mua 3 phở" survive
      .replace(/(?:sau|trong)\s+\d+\s*(?:phút|p|tiếng|giờ|h|ngày)(?!\p{L})(?:\s*nữa)?/giu, '')
      .replace(/\d+\s*(?:phút|p|tiếng|giờ|h|ngày)(?!\p{L})\s*nữa/giu, '')
      .replace(/nửa\s+(?:tiếng|giờ)\s*(?:nữa)?/gi, '')
      // 9. Remove 24h format: "16h30", "lúc 15h" — require h/: not immediately followed by letter
      .replace(/(?:lúc\s+)?\d{1,2}\s*(?:h(?!\p{L})|giờ(?!\p{L})|:)\s*\d{0,2}/giu, '')
      // 11. Remove priority words and filler words ("việc gấp", "nhé")
      .replace(CRITICAL_STRIP_RE, '')
      .replace(/(?:^|\s)(?:nhé|nha)\s*[.!]*$/i, '')
      .replace(/\blúc\b/gi, '')
      // 12. Normalize whitespace and trailing symbols
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;]+$/g, '')
      .trim();
  }
}
