/**
 * Real-browser shell UTF-8 integration tests (issue #957).
 *
 * These run in headless Chromium (see `vitest.integration.config.ts`) against
 * the **shipped** just-bash engine — the exact build the webapp loads in the
 * browser (`just-bash`'s `browser` export, patched by
 * `patches/just-bash+3.0.1.patch`). They exist because the Node unit harness
 * cannot faithfully run the scripts the agent generates: under Node, just-bash's
 * defense-in-depth box dynamic-imports `node:module` and aborts multi-statement
 * scripts (`VAR=$(cat f); use $VAR`, assignment + pipeline, …). The browser has
 * no `node:module`, so those scripts execute exactly as they do for a user —
 * which is the only place these UTF-8 paths can be exercised end-to-end.
 *
 * The bug: `$(...)` / multi-statement output that interleaves text-shaped
 * (sed, awk, echo) and byte-shaped (cat, grep|head, tail) commands came out as
 * Latin-1 mojibake (`KÃ¶penicker` for `Köpenicker`, `â€”` for `—`). Root cause
 * was just-bash's `Interpreter.executeScript`, which concatenated each
 * statement's raw stdout before a single UTF-8 decode at the `exec()` boundary;
 * the lone high byte from the text half made the combined stream invalid UTF-8,
 * so the boundary decoder bailed and left the byte half undecoded. Fixed by
 * decoding each statement's stdout in isolation first (mirrors just-bash PR
 * #265). See `patches/just-bash+3.0.1.patch`.
 */

import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';

/** UTF-8 byte view of a JS string as a `"e2 80 94"`-style hex string. */
function utf8Hex(s: string): string {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

const EM_DASH = '—'; // U+2014 → e2 80 94

describe('just-bash $(...) / interleave UTF-8 in the actual browser', () => {
  it('round-trips non-ASCII when text and byte statements interleave', async () => {
    const b = new Bash({ files: { '/doc.txt': 'Köpenicker\n' } });
    // sed is text-shaped (ö as U+00F6); grep|head is byte-shaped (ö as c3 b6).
    expect((await b.exec('sed -n 1p /doc.txt\ngrep Köpenicker /doc.txt | head -1')).stdout).toBe(
      'Köpenicker\nKöpenicker\n'
    );
    expect((await b.exec('sed -n 1p /doc.txt; grep Köpenicker /doc.txt | head -1')).stdout).toBe(
      'Köpenicker\nKöpenicker\n'
    );
  });

  it('decodes a byte producer inside command substitution before splicing', async () => {
    const b = new Bash({ files: { '/world.txt': '世界\n' } });
    expect((await b.exec('echo "你好: $(cat /world.txt)"')).stdout).toBe('你好: 世界\n');
    expect((await b.exec('echo "Company: $(grep 世界 /world.txt)"')).stdout).toBe(
      'Company: 世界\n'
    );
  });

  it('handles 3-byte (CJK) and 4-byte (emoji) codepoints across the interleave', async () => {
    const cjk = new Bash({ files: { '/d.txt': '日本語\n' } });
    expect((await cjk.exec('sed -n 1p /d.txt\ngrep 日本語 /d.txt | head -1')).stdout).toBe(
      '日本語\n日本語\n'
    );
    const emoji = new Bash({ files: { '/e.txt': '🌍\n' } });
    expect((await emoji.exec('sed -n 1p /e.txt\ngrep 🌍 /e.txt | head -1')).stdout).toBe(
      '🌍\n🌍\n'
    );
  });

  it('leaves standalone text and byte producers unchanged (regression guard)', async () => {
    const b = new Bash({ files: { '/doc.txt': 'Köpenicker\n' } });
    expect((await b.exec('sed -n 1p /doc.txt')).stdout).toBe('Köpenicker\n');
    expect((await b.exec('grep Köpenicker /doc.txt | head -1')).stdout).toBe('Köpenicker\n');
  });

  it('passes raw binary through cat → file untouched by the decode', async () => {
    const b = new Bash({ files: { '/b.bin': new Uint8Array([0x80, 0xff, 0x00, 0x90]) } });
    await b.exec('cat /b.bin | cat > /out.bin');
    const out = await b.fs.readFileBuffer('/out.bin');
    expect(Array.from(out)).toEqual([0x80, 0xff, 0x00, 0x90]);
  });
});

/**
 * The original report: `$(...)` captured into a shell var in one command, then
 * re-emitted in the next. SLICC's `AlmostBashShellHeadless.runCommand` carries the
 * previous `exec()`'s `result.env` into the next `exec()`'s `env` (the panel
 * terminal and the agent's bash tool both drive it that way). These tests
 * reproduce that env round-trip against the shipped engine — and crash under
 * Node's defense-in-depth box, which is exactly why they must run in a browser.
 */
describe('UTF-8 across separate exec() calls with carried env (issue #957)', () => {
  /** Mirror `runCommand`: thread `result.env` from one exec into the next. */
  async function runSequence(
    files: Record<string, string | Uint8Array>,
    commands: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const bash = new Bash({ files });
    let env: Record<string, string> | undefined;
    let last = { stdout: '', stderr: '', exitCode: 0 };
    for (const cmd of commands) {
      const r = await bash.exec(cmd, env ? { env } : {});
      if (r.env) env = { ...r.env };
      last = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    }
    return last;
  }

  it('preserves UTF-8 through $(...) captured into a var and re-emitted (the exact report)', async () => {
    const r = await runSequence({ '/utf8.txt': `${EM_DASH}\n` }, [
      'VAR=$(cat /utf8.txt)',
      'printf %s "$VAR"',
    ]);
    expect(r.exitCode).toBe(0);
    expect(utf8Hex(r.stdout)).toBe(utf8Hex(EM_DASH));
    expect(r.stdout).toBe(EM_DASH);
  });

  it('echoes a captured UTF-8 var across exec() calls', async () => {
    const r = await runSequence({ '/utf8.txt': `${EM_DASH}\n` }, [
      'VAR=$(cat /utf8.txt)',
      'echo "$VAR"',
    ]);
    expect(r.stdout).toBe(`${EM_DASH}\n`);
  });

  it('writes a captured UTF-8 var back to a file without double-encoding', async () => {
    const bash = new Bash({ files: { '/in.txt': EM_DASH } });
    const r1 = await bash.exec('VAR=$(cat /in.txt)');
    const env = r1.env ? { ...r1.env } : undefined;
    await bash.exec('printf %s "$VAR" > /out.txt', env ? { env } : {});
    // The original report saw c3 a2 c2 80 c2 94 (double-encoded) on disk here.
    const onDisk = await bash.fs.readFileBuffer('/out.txt');
    expect(Array.from(onDisk)).toEqual([0xe2, 0x80, 0x94]);
  });

  it('builds a message payload from a UTF-8 file via $(...) without mojibake', async () => {
    // Mirrors the real-world Slack chat.postMessage failure in the report.
    const r = await runSequence({ '/msg.txt': 'price: 5 × 3 — done 🌍' }, [
      'TEXT=$(cat /msg.txt)',
      'printf %s "$TEXT"',
    ]);
    expect(r.stdout).toBe('price: 5 × 3 — done 🌍');
  });
});
