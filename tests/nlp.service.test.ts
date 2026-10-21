import { describe, it, expect } from 'vitest';
import { NlpService } from '../src/services/nlp.service';

describe('NlpService', () => {
  const service = new NlpService(); // Fallback heuristic mode

  it('detects list tasks intent', async () => {
    const result = await service.parseUserPrompt('Xem danh sách công việc của tôi');
    expect(result.intent).toBe('LIST_TASKS');
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
});
