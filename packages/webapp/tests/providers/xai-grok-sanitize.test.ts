import { describe, expect, it } from 'vitest';
import { sanitizePayload } from '../../providers/xai-grok-sanitize.js';

describe('sanitizePayload', () => {
  it('strips replayed reasoning items from input', () => {
    const out = sanitizePayload(
      {
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'reasoning', summary: ['…'] },
        ],
      },
      'grok-4.3'
    );
    expect((out.input as unknown[]).some((m: any) => m.type === 'reasoning')).toBe(false);
  });

  it('hoists system/developer roles into top-level instructions', () => {
    const out = sanitizePayload(
      {
        input: [
          { role: 'developer', content: 'follow style guide X' },
          { role: 'system', content: [{ type: 'input_text', text: 'be concise' }] },
          { role: 'user', content: 'hi' },
        ],
      },
      'grok-4.3'
    );
    expect(out.instructions).toBe('follow style guide X\n\nbe concise');
    expect((out.input as any[]).every((m) => m.role !== 'developer' && m.role !== 'system')).toBe(
      true
    );
  });

  it('drops unresolvable local-path images and never leaves null entries in the array', () => {
    const out = sanitizePayload(
      {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'check this' },
              { type: 'input_image', image_url: '/Users/local/path.png' },
              { type: 'input_image', image_url: 'https://example.com/ok.png' },
            ],
          },
        ],
      },
      'grok-4.3'
    );
    const content = (out.input as any[])[0].content as unknown[];
    expect(content.every((p) => p !== null)).toBe(true);
    expect(content.length).toBe(2);
    expect((content[1] as any).type).toBe('input_image');
    expect((content[1] as any).image_url).toBe('https://example.com/ok.png');
  });

  it('rewrites function_call_output entries that contain images into a follow-up user message', () => {
    const out = sanitizePayload(
      {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call-1',
            output: [
              { type: 'output_text', text: 'screenshot taken' },
              { type: 'input_image', image_url: 'https://example.com/shot.png' },
            ],
          },
        ],
      },
      'grok-4.3'
    );
    const items = out.input as any[];
    expect(items.length).toBe(2);
    expect(items[0].type).toBe('function_call_output');
    expect(typeof items[0].output).toBe('string');
    expect(items[1].role).toBe('user');
    expect(items[1].content[0].type).toBe('input_text');
    expect(items[1].content[1].type).toBe('input_image');
  });

  it('translates response_format → text.format', () => {
    const out = sanitizePayload(
      {
        input: [],
        response_format: { type: 'json_schema', schema: { type: 'object' } },
      },
      'grok-4.3'
    );
    expect(out.response_format).toBeUndefined();
    expect(out.text).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
  });

  it('strips reasoning param on models that do not support reasoning.effort', () => {
    const out = sanitizePayload(
      { input: [], reasoning: { effort: 'high' } },
      'grok-4.20-0309-non-reasoning'
    );
    expect(out.reasoning).toBeUndefined();
  });

  it('remaps reasoning.effort "minimal" to "low" for effort-capable models', () => {
    const out = sanitizePayload({ input: [], reasoning: { effort: 'minimal' } }, 'grok-4.3');
    expect((out.reasoning as any).effort).toBe('low');
  });

  it('sets prompt_cache_key from sessionId', () => {
    const out = sanitizePayload({ input: [] }, 'grok-4.3', 'session-xyz');
    expect(out.prompt_cache_key).toBe('session-xyz');
  });

  it('removes reasoning.encrypted_content from include[]', () => {
    const out = sanitizePayload(
      { input: [], include: ['reasoning.encrypted_content', 'other'] },
      'grok-4.3'
    );
    expect(out.include).toEqual(['other']);
  });
});
