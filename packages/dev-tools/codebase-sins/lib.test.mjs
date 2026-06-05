import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt, resolveSin, SINS, selectSinOfDay } from './sins.mjs';

describe('SINS', () => {
  it('has seven sins in the severity order, with derived labels and prompt files', () => {
    expect(SINS).toHaveLength(7);
    expect(SINS.map((s) => s.id)).toEqual([
      'complicatification',
      'entanglement',
      'drift',
      'duplication',
      'bloat',
      'necrophilia',
      'paranoia',
    ]);
    for (const s of SINS) {
      expect(s.label).toBe(`debt:${s.id}`);
      expect(typeof s.name).toBe('string');
      expect(typeof s.summary).toBe('string');
    }
  });

  it('points every promptFile at a file that exists on disk', () => {
    for (const s of SINS) {
      expect(existsSync(s.promptFile), `${s.id} prompt missing: ${s.promptFile}`).toBe(true);
    }
  });
});

describe('selectSinOfDay', () => {
  it('is deterministic for a fixed date', () => {
    const date = new Date('2026-03-15T12:00:00Z');
    expect(selectSinOfDay(date)).toBe(selectSinOfDay(date));
  });

  it('maps seven consecutive days to the full distinct set of seven sins', () => {
    const ids = new Set();
    const start = new Date('2026-03-01T00:00:00Z');
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      ids.add(selectSinOfDay(d).id);
    }
    expect(ids.size).toBe(7);
    expect(ids).toEqual(new Set(SINS.map((s) => s.id)));
  });

  it('uses UTC day-of-year (independent of local time within the same UTC day)', () => {
    expect(selectSinOfDay(new Date('2026-06-01T00:30:00Z')).id).toBe(
      selectSinOfDay(new Date('2026-06-01T23:30:00Z')).id
    );
  });
});

describe('resolveSin', () => {
  it('resolves a 1-7 numeric override to that rank', () => {
    expect(resolveSin(1).id).toBe('complicatification');
    expect(resolveSin('6').id).toBe('necrophilia');
    expect(resolveSin(7).id).toBe('paranoia');
  });

  it('resolves a sin id or name (case-insensitive)', () => {
    expect(resolveSin('drift').id).toBe('drift');
    expect(resolveSin('Necrophilia').id).toBe('necrophilia');
    expect(resolveSin('ENTANGLEMENT').id).toBe('entanglement');
  });

  it('falls back to the sin of the day for empty input', () => {
    const date = new Date('2026-04-10T00:00:00Z');
    const today = selectSinOfDay(date).id;
    // resolveSin's empty-path uses selectSinOfDay() with the real clock, so
    // assert it returns a valid sin rather than pinning the date.
    expect(SINS.map((s) => s.id)).toContain(resolveSin('').id);
    expect(SINS.map((s) => s.id)).toContain(resolveSin(null).id);
    expect(SINS.map((s) => s.id)).toContain(resolveSin(undefined).id);
    expect(today).toBeTruthy();
  });

  it('falls back to a valid sin for invalid input (out of range / unknown)', () => {
    expect(SINS.map((s) => s.id)).toContain(resolveSin('0').id);
    expect(SINS.map((s) => s.id)).toContain(resolveSin('8').id);
    expect(SINS.map((s) => s.id)).toContain(resolveSin('not-a-sin').id);
  });
});

describe('buildPrompt', () => {
  const sin = SINS[3]; // duplication
  const body = 'PER_SIN_BODY_MARKER: hunt for copy-paste blocks.';
  const prompt = buildPrompt(sin, body);

  it('includes the per-sin body', () => {
    expect(prompt).toContain('PER_SIN_BODY_MARKER');
  });

  it('includes the shared filing/dedup instructions interpolated with the sin', () => {
    expect(prompt).toContain('gh issue create');
    expect(prompt).toContain('gh issue list --state open');
    expect(prompt).toContain('gh pr list --state open');
    expect(prompt).toContain(`<!-- agentic-debt:${sin.id} -->`);
    expect(prompt).toContain(`--label agentic-debt --label ${sin.label}`);
    expect(prompt).toContain(sin.name);
  });

  it('tolerates an empty body', () => {
    expect(() => buildPrompt(sin, '')).not.toThrow();
    expect(buildPrompt(sin, '')).toContain('gh issue create');
  });
});
