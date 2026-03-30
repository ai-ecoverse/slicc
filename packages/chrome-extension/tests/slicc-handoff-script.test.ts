import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../../.agents/skills/slicc-handoff/scripts/slicc-handoff', import.meta.url)
);

function decodePayloadFromUrl(url: string): Record<string, unknown> {
  const fragment = url.trim().split('#')[1] ?? '';
  return JSON.parse(Buffer.from(fragment, 'base64url').toString('utf8'));
}

describe('slicc-handoff helper script', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reads payload JSON from a file path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'slicc-handoff-'));
    const payloadPath = join(tempDir, 'payload.json');
    writeFileSync(
      payloadPath,
      JSON.stringify({ instruction: 'Read from a file.', urls: ['https://example.com'] }),
      'utf8'
    );

    const result = spawnSync(process.execPath, [scriptPath, payloadPath], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('https://www.sliccy.ai/handoff#');
    expect(decodePayloadFromUrl(result.stdout)).toEqual({
      instruction: 'Read from a file.',
      urls: ['https://example.com'],
    });
  });

  it('auto-detects piped stdin without requiring --stdin', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      input: JSON.stringify({ instruction: 'Read from stdin automatically.' }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(decodePayloadFromUrl(result.stdout)).toEqual({
      instruction: 'Read from stdin automatically.',
    });
  });

  it('keeps --stdin working as a compatibility alias', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--stdin'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      input: JSON.stringify({ instruction: 'Compatibility mode.' }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(decodePayloadFromUrl(result.stdout)).toEqual({
      instruction: 'Compatibility mode.',
    });
  });
});
