import { NlpExtractedTask } from '../types/task';
import {
  getNowWithTimezone,
  getVietnameseDayOfWeek,
  getDaysInMonth,
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
    this.apiKey = apiKey?.trim() || undefined;
    this.model = model?.trim() || 'gemini-3.8-flash';
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
    const systemPrompt = `
Bạn là bộ máy phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại của người dùng là: ${currentIso} (${dayOfWeek}).
Múi giờ của người dùng: ${timezone} (UTC${tzOffset}).

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
     VD: "trưa mai làm báo cáo" -> ngày mai lúc 12:00:00${tzOffset}, title: "làm báo cáo".
   - "Mốt", "ngày kia", "trưa mốt", "sáng mốt", "chiều mốt", "tối mốt": ngày hiện tại + 2 ngày.
   - "Thứ X tuần sau": Tính đúng ngày Thứ X của tuần kế tiếp (Tuần bắt đầu từ Thứ Hai).
4. Việc lặp lại định kỳ (recurrence_rrule):
   - "ngày X hàng tháng" (hoặc "ngày X mỗi tháng", "mỗi tháng ngày X"):
     + recurrence_rrule = "FREQ=MONTHLY;BYMONTHDAY=X".
     + due_at_iso: Nếu ngày X của tháng hiện tại đã qua so với thời điểm hiện tại, lần nhắc đầu tiên PHẢI là ngày X của THÁNG KẾ TIẾP! (Nếu là tháng 12 thì sang tháng 1 năm sau). Nếu ngày X chưa tới trong tháng này, lấy ngày X của tháng này. Mặc định 09:00:00 sáng nếu không nói giờ.
   - "mỗi ngày" / "hàng ngày": recurrence_rrule = "FREQ=DAILY".
   - "thứ X hàng tuần" / "thứ X mỗi tuần": recurrence_rrule = "FREQ=WEEKLY;BYDAY=...".
5. Quy tắc trường due_at_iso:
   - BẮT BUỘC có offset múi giờ ${tzOffset} (Ví dụ: "2026-10-23T12:00:00${tzOffset}").
   - TUYỆT ĐỐI KHÔNG dùng ký tự "Z" và KHÔNG ĐƯỢC bỏ trống phần offset.
6. Tiêu đề (title):
   - Chỉ giữ lại nội dung công việc cốt lõi, LOẠI BỎ các từ chỉ thời gian và lời chào/mệnh lệnh như "nhắc tôi", "nhắc mình", "trưa mai", "ngày 4 hàng tháng", "chiều nay"...
   - Đối với intent "CREATE_TASK", trường "title" KHÔNG ĐƯỢC để trống hoặc null.
7. Mức độ ưu tiên (priority):
   - Nếu có từ "gấp", "quan trọng", "nhớ nhắc kỹ", "khẩn": priority = "CRITICAL", nagging_mode = true.
   - Bình thường: priority = "MEDIUM", nagging_mode = false.
8. Nếu người dùng muốn xem/liệt kê danh sách việc: intent = "LIST_TASKS".
   Nếu người dùng muốn hủy/xóa việc: intent = "CANCEL_TASK".
    `.trim();

    // Prepare list of models: primary model (gemini-3.8-flash) and fallback if 404
    const modelsToTry = [this.model];
    if (this.model !== 'gemini-2.5-flash') {
      modelsToTry.push('gemini-2.5-flash');
    }

    const startOverall = Date.now();
    let lastError: string | undefined;

    for (const modelToUse of modelsToTry) {
      try {
        console.log(`[NLP-DEBUG] 🚀 Calling Gemini API (model: ${modelToUse}) for: "${text}"`);
        const startTime = Date.now();

        // Attempt 1: with fast thinking configuration (thinkingLevel: "LOW" on 3.x / thinkingBudget: 0 on 2.5)
        let res = await this.requestGemini(modelToUse, text, systemPrompt, true);

        // If HTTP 400 Bad Request, model might not support thinkingConfig. Retry without thinkingConfig.
        if (!res.ok && res.status === 400) {
          console.warn(`[NLP-DEBUG] ⚠️ Gemini 400 with thinkingConfig on ${modelToUse}. Retrying without thinkingConfig...`);
          res = await this.requestGemini(modelToUse, text, systemPrompt, false);
        }

        const callDuration = Date.now() - startTime;

        // If HTTP 404 (model ID not found), HTTP 0 (timeout), or HTTP 503 (capacity overloaded), try fallback model
        if (!res.ok && (res.status === 404 || res.status === 0 || res.status === 503)) {
          lastError = res.status === 0 ? 'The operation was aborted due to timeout' : `HTTP ${res.status}: ${res.error}`;
          console.warn(`[NLP-DEBUG] ⚠️ Gemini model ${modelToUse} failed (status: ${res.status}, ${callDuration}ms). Trying fallback model...`);
          continue;
        }

        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${res.error}`;
          console.error(`[NLP-DEBUG] ❌ Gemini API error on model ${modelToUse} (${res.status}, ${callDuration}ms):`, res.error);
          break; // Stop immediately on non-recoverable errors (e.g. 401, 403 invalid key)
        }

        // Extract JSON string from response candidates (handling thought parts and markdown fences)
        const rawJson = this.extractJsonFromCandidate(res.data?.candidates?.[0]);
        if (!rawJson) {
          lastError = 'Gemini returned response without valid JSON payload';
          console.warn(`[NLP-DEBUG] ⚠️ Gemini model ${modelToUse} returned no valid JSON part (${callDuration}ms), raw response:`, JSON.stringify(res.data));
          break;
        }

        const parsed = JSON.parse(rawJson) as NlpExtractedTask;
        const sanitized = this.sanitizeGeminiOutput(parsed, text, currentIso);
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
        break;
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

    const systemPrompt = `
Bạn là bộ máy phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại của người dùng là: ${currentIso} (${dayOfWeek}).
Múi giờ của người dùng: ${timezone} (UTC${tzOffset}).
Nhiệm vụ: Phân tích câu nói của người dùng và trả về JSON theo đúng schema.
    `.trim();

    const modelsToTry = [this.model];
    if (this.model !== 'gemini-2.5-flash') {
      modelsToTry.push('gemini-2.5-flash');
    }

    let finalResult: NlpExtractedTask | null = null;
    let finalSource: 'GEMINI' | 'REGEX_FALLBACK' | 'REGEX_NO_API_KEY' = 'REGEX_FALLBACK';

    for (const modelToUse of modelsToTry) {
      const start = Date.now();
      let res = await this.requestGemini(modelToUse, text, systemPrompt, true);
      if (!res.ok && res.status === 400) {
        res = await this.requestGemini(modelToUse, text, systemPrompt, false);
      }
      const dur = Date.now() - start;

      const rawJson = this.extractJsonFromCandidate(res.data?.candidates?.[0]);

      attempts.push({
        model: modelToUse,
        status: res.status,
        durationMs: dur,
        error: res.error,
        rawSnippet: rawJson ? rawJson.slice(0, 300) : (res.error?.slice(0, 300) || JSON.stringify(res.data)?.slice(0, 300)),
      });

      if (res.ok && rawJson) {
        try {
          const parsed = JSON.parse(rawJson) as NlpExtractedTask;
          finalResult = this.sanitizeGeminiOutput(parsed, text, currentIso);
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

      if (!res.ok && (res.status === 404 || res.status === 0 || res.status === 503)) {
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
   * Builds the appropriate thinkingConfig based on model family.
   * Gemini 3.x models use thinkingLevel: "LOW" to minimize reasoning latency for schema output.
   * Gemini 2.5 models use thinkingBudget: 0 to disable thinking entirely.
   */
  private buildThinkingConfig(model: string): Record<string, unknown> | undefined {
    if (model.includes('3.')) {
      return {
        thinkingLevel: 'LOW',
      };
    }
    if (model.includes('2.5')) {
      return {
        thinkingBudget: 0,
      };
    }
    return undefined;
  }

  /**
   * Low-level fetch wrapper for Google Gemini REST API.
   */
  private async requestGemini(
    model: string,
    text: string,
    systemPrompt: string,
    enableFastThinking = true
  ): Promise<{ ok: boolean; status: number; error?: string; data?: GeminiGenerateResponse }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const generationConfig: Record<string, unknown> = {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_JSON_SCHEMA,
      temperature: 0.1,
    };

    if (enableFastThinking) {
      const thinkingConfig = this.buildThinkingConfig(model);
      if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }
    }

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
        signal: AbortSignal.timeout(25000), // 25s timeout ensures complete response without premature abort
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
    currentIso: string
  ): NlpExtractedTask {
    if (parsed.intent === 'UNKNOWN') {
      const fastFallback = this.fastPatternParse(text, currentIso);
      if (fastFallback) {
        return fastFallback;
      }
      return parsed;
    }

    if (parsed.intent === 'CREATE_TASK') {
      const isCritical = /gấp|khẩn|quan trọng|nhớ nhắc kỹ/i.test(text);

      if (!parsed.title || !parsed.title.trim()) {
        parsed.title = this.buildCleanTitle(text) || text;
      } else {
        parsed.title = parsed.title.trim();
      }

      if (!parsed.due_at_iso) {
        const regexTask = this.fastPatternParse(text, currentIso);
        if (regexTask?.due_at_iso) {
          parsed.due_at_iso = regexTask.due_at_iso;
          if (parsed.remind_before_minutes === undefined || parsed.remind_before_minutes === null) {
            parsed.remind_before_minutes = regexTask.remind_before_minutes;
          }
        } else {
          parsed.due_at_iso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
   * Deterministic fallback when Gemini API is unavailable, times out, or has no API key.
   */
  private heuristicFallback(text: string, currentIso: string): NlpExtractedTask {
    return (
      this.fastPatternParse(text, currentIso) || {
        intent: 'CREATE_TASK',
        title: this.buildCleanTitle(text) || text,
        due_at_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        remind_before_minutes: 0,
        priority: 'MEDIUM',
        nagging_mode: false,
        recurrence_rrule: null,
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

    const isCritical = /gấp|khẩn|quan trọng|nhớ nhắc kỹ/.test(lower);
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
    // STEP 2: Absolute time WITH period (e.g. "4h30 chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "11h trưa")
    // ================================================================
    const timeWithPeriod = lowerWithoutRemindBefore.match(
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

        const parsedMin = capturedMin ? parseInt(capturedMin, 10) : isRuoi ? 30 : 0;
        if (parsedMin >= 0 && parsedMin <= 59) {
          targetMinute = parsedMin;
          if (period === 'chiều' || period === 'tối') {
            targetHour = h < 12 ? h + 12 : h;
          } else if (period === 'sáng' && h === 12) {
            targetHour = 0;
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
    if (!matchedAbsoluteTime) {
      const relMinMatch = lowerWithoutRemindBefore.match(
        /(?:sau|trong)?\s*(\d+)\s*(?:phút|p)\s*(?:nữa)?/
      );
      const relHourMatch = lowerWithoutRemindBefore.match(
        /(?:sau|trong)?\s*(\d+)\s*(?:tiếng|giờ|h)\s*(?:nữa)?/
      );
      const isHalfHour = /nửa\s+(?:tiếng|giờ)/.test(lowerWithoutRemindBefore);

      let minutesToAdd = 0;
      if (isHalfHour) {
        minutesToAdd = 30;
      } else if (
        relMinMatch &&
        (lowerWithoutRemindBefore.includes('nữa') ||
          lowerWithoutRemindBefore.includes('sau') ||
          lowerWithoutRemindBefore.includes('trong') ||
          lowerWithoutRemindBefore.includes('nhắc'))
      ) {
        minutesToAdd = parseInt(relMinMatch[1], 10);
      } else if (
        relHourMatch &&
        (lowerWithoutRemindBefore.includes('nữa') ||
          lowerWithoutRemindBefore.includes('sau') ||
          lowerWithoutRemindBefore.includes('trong'))
      ) {
        minutesToAdd = parseInt(relHourMatch[1], 10) * 60;
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
        lowerWithoutRemindBefore.match(/\b(sáng|trưa|chiều|tối)\s*(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\b/) ||
        lowerWithoutRemindBefore.match(/\b(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\s+(sáng|trưa|chiều|tối)\b/);

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
        /(?:lúc\s+)?(\d{1,2})[h:](\d{1,2})?(?!\p{L})/u
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

    // Check for explicit date DD/MM or ngày DD/MM(/YYYY)
    const explicitDateMatch = lowerWithoutRemindBefore.match(
      /(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?(?!\d)/
    );

    // Check for standalone weekday: "thứ 6", "thứ sáu tuần sau", "chủ nhật"
    const weekdayMatch = lowerWithoutRemindBefore.match(
      /(?:(thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\s*nhật))(?:\s+(tuần\s+(?:sau|tới|này)))?/
    );

    if (targetHour === null && (explicitDateMatch || weekdayMatch)) {
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
        const hasExplicitToday = /\b(?:hôm\s*nay|nay)\b/.test(lowerWithoutRemindBefore);
        if (/\bmốt\b/.test(lowerWithoutRemindBefore) || /\bngày\s*kia\b/.test(lowerWithoutRemindBefore)) {
          dayOffset = 2;
        } else if (/\bmai\b/.test(lowerWithoutRemindBefore) || /\bngày\s*mai\b/.test(lowerWithoutRemindBefore)) {
          dayOffset = 1;
        } else if (!hasExplicitToday) {
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
        const { hour, minute } = this.extractTimeFromText(lower);
        const timeAlreadyPassedToday =
          hour < currentHour || (hour === currentHour && minute <= currentMinute);

        let daysUntil = targetWeekday - currentWeekday;
        if (daysUntil < 0 || (daysUntil === 0 && timeAlreadyPassedToday)) {
          daysUntil += 7;
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
          recurrence_rrule: `FREQ=WEEKLY;BYDAY=${rruleDay}`,
        };
      }
    }

    // --- "chủ nhật hàng tuần" / "chủ nhật mỗi tuần" ---
    if (/chủ\s*nhật\s+(?:hàng|mỗi)\s+tuần/.test(lower)) {
      const todayDate = new Date(Date.UTC(baseY, baseM - 1, baseD));
      const currentWeekday = todayDate.getUTCDay();
      const { hour, minute } = this.extractTimeFromText(lower);
      const timeAlreadyPassedToday =
        hour < currentHour || (hour === currentHour && minute <= currentMinute);

      let daysUntil = 0 - currentWeekday; // Sunday = 0
      if (daysUntil < 0 || (daysUntil === 0 && timeAlreadyPassedToday)) {
        daysUntil += 7;
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
        const m = minStr ? parseInt(minStr, 10) : isRuoi ? 30 : 0;
        if (m >= 0 && m <= 59) {
          if ((period === 'chiều' || period === 'tối') && h < 12) h += 12;
          if (period === 'sáng' && h === 12) h = 0;
          return { hour: h, minute: m };
        }
      }
    }

    const time24 = lower.match(/(?:lúc\s+)?(\d{1,2})[h:](\d{1,2})?(?!\p{L})/u);
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
      // 1. Remove recurring patterns FIRST (before general hours or numbers to avoid "4 hàng" -> "4h")
      .replace(/ngày\s+\d{1,2}\s+(?:hàng|mỗi)\s+tháng/gi, '')
      .replace(/(?:hàng|mỗi)\s+tháng\s+(?:vào\s+)?ngày\s+\d{1,2}/gi, '')
      .replace(/(?:(?:sáng|trưa|chiều|tối)\s+)?thứ\s+(?:\d|hai|ba|tư|năm|sáu|bảy)\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/(?:(?:sáng|trưa|chiều|tối)\s+)?chủ\s*nhật\s+(?:hàng|mỗi)\s+tuần/gi, '')
      .replace(/(?:mỗi|hàng)\s+(?:ngày|tuần|tháng)/gi, '')
      // 2. Remove pre-reminder instructions ("nhắc trước 15 phút", "báo trước 30p")
      .replace(/(?:nhắc|báo)\s+trước\s+\d+\s*(?:phút|p)/gi, '')
      // 3. Remove "nhắc tôi/mình/em"
      .replace(/nhắc\s*(?:tôi|mình|em)?\s*/gi, '')
      // 4. Remove time + period: "4h30 chiều", "4 giờ 45 chiều", "3 rưỡi sáng", "8 giờ tối"
      .replace(/\d{1,2}\s*(?:h|giờ|:)?\s*\d{0,2}\s*(?:rưỡi)?\s*(?:sáng|trưa|chiều|tối)/gi, '')
      // 5. Remove standalone weekday (with optional period and week modifier): "Chiều thứ 6", "thứ 6 tuần sau"
      .replace(
        /(?:(?:sáng|trưa|chiều|tối)\s+)?(?:thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ\s*nhật)(?:\s+tuần\s+(?:sau|tới|này))?(?:\s+(?:sáng|trưa|chiều|tối))?/gi,
        ''
      )
      // 6. Remove explicit DD/MM(/YYYY) dates
      .replace(/(?:(?:sáng|trưa|chiều|tối)\s+)?(?:ngày\s+)?\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{4})?(?!\d)/gi, '')
      // 7. Remove standalone period + date: "trưa mai", "sáng mai", "chiều nay", "tối mốt"
      .replace(/(?:sáng|trưa|chiều|tối)\s*(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)/gi, '')
      .replace(/(?:hôm\s*nay|nay|ngày\s*mai|mai|mốt|ngày\s*kia)\s+(?:sáng|trưa|chiều|tối)/gi, '')
      // 8. Remove standalone date words: "hôm nay", "ngày mai", "ngày kia"
      .replace(/\bhôm\s*nay\b/gi, '')
      .replace(/\bngày\s*(?:mai|mốt|kia)\b/gi, '')
      .replace(/\b(?:mai|mốt|nay)\b/gi, '')
      // 9. Remove 24h format: "16h30", "lúc 15h" — require h/: not immediately followed by letter
      .replace(/(?:lúc\s+)?\d{1,2}(?:h(?!\p{L})|:)\d{0,2}/gu, '')
      // 10. Remove relative time: "sau 10 phút", "2 tiếng nữa", "nửa tiếng nữa"
      .replace(/(?:sau|trong)?\s*\d+\s*(?:phút|p|tiếng|giờ)\s*(?:nữa)?/gi, '')
      .replace(/nửa\s+(?:tiếng|giờ)\s*(?:nữa)?/gi, '')
      // 11. Remove priority words and filler words ("việc gấp", "nhé")
      .replace(/(?:việc\s+)?(?:gấp|khẩn\s*cấp|khẩn|quan trọng|nhớ nhắc kỹ)(?:\s+nhé)?/gi, '')
      .replace(/\blúc\b/gi, '')
      // 12. Normalize whitespace and trailing symbols
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;]+$/g, '')
      .trim();
  }
}
