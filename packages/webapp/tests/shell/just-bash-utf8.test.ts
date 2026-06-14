/**
 * Fast Node-level guard for the just-bash UTF-8 fix (issue #957 /
 * `patches/just-bash+3.0.1.patch`, mirroring just-bash PR #265).
 *
 * Scope note: this covers only the cases that just-bash's defense-in-depth box
 * lets run under Node — single-statement scripts and command substitution. The
 * multi-statement / `$(...)`-captured-into-a-var scenarios from the original
 * report abort under Node (`node:module` dynamic import is blocked), so they
 * live in the real-browser suite at
 * `packages/webapp/tests/integration/shell-utf8.integration.test.ts`. Keep both
 * in sync.
 *
 * Without the patch these assertions fail with Latin-1 mojibake
 * (`KÃ¶penicker`, `æ¥æ¬èª`); see the integration suite for the env round-trip
 * that produced the report's `c3 a2 c2 80 c2 94` on-disk bytes.
 */

import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';

describe('just-bash UTF-8 text/byte statement interleave (PR #265 patch)', () => {
  it('round-trips non-ASCII when sed (text) and grep|head (bytes) interleave', async () => {
    const b = new Bash({ files: { '/doc.txt': 'Köpenicker\n' } });
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
