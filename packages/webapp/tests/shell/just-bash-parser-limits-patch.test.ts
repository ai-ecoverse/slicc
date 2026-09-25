import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// The parser's caps are execution limits (vercel-labs/just-bash#491). Upstream
// 3.4.2 hard-codes a 1 MB input cap, 100,000 tokens, 1,000,000 parse
// iterations and 10,000 top-level statements, so `maxSourceBytes` never took
// effect and ImageMagick's 1.3 MB configure could not parse. The input cap is
// now maxSourceBytes; maxParserTokens / maxParseIterations (defaults unchanged)
// set the rest, for exec, `source`, `eval` and a script run by path.
const lines = (n: number) =>
  `${Array.from({ length: n }, (_, i) => `v${i}=${i}`).join('\n')}\necho ran $v${n - 1}\n`;
const LIFTED = {
  maxParserTokens: Number.POSITIVE_INFINITY,
  maxParseIterations: Number.POSITIVE_INFINITY,
  maxCommandCount: Number.POSITIVE_INFINITY,
};

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash parser limits patch (%s)', (_runtime, Shell) => {
  it('parses a script past the old caps once the limits are lifted', async () => {
    // 150,000 statements, 300,000 tokens, 2 MB.
    const big = lines(150000);
    expect(big.length).toBeGreaterThan(1_000_000);
    const r = await new Shell({ executionLimits: LIFTED }).exec(big);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('ran 149999\n');
  }, 120_000);

  it('applies the lifted limits to source, eval and a script run by path', async () => {
    const shell = new Shell({ executionLimits: LIFTED, files: { '/big.sh': lines(60000) } });
    expect((await shell.exec('. /big.sh')).stdout).toBe('ran 59999\n');
    expect((await shell.exec('eval "$(cat /big.sh)"')).stdout).toBe('ran 59999\n');
    // ./configure: a script executed by path has its own parse call.
    expect((await shell.exec('chmod +x /big.sh && /big.sh')).stdout).toBe('ran 59999\n');
  }, 120_000);

  it('keeps the default token cap, now reported against the configured limit', async () => {
    const r = await new Shell().exec(lines(60000));
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Too many tokens: .* exceeds limit of 100000/);
    const tight = await new Shell({ executionLimits: { maxParserTokens: 50 } }).exec(lines(40));
    expect(tight.stderr).toMatch(/exceeds limit of 50/);
  }, 120_000);

  it('caps the input at maxSourceBytes', async () => {
    const r = await new Shell({ executionLimits: { maxSourceBytes: 100 } }).exec(lines(40));
    expect(r.stdout).toBe('');
    expect(r.exitCode).not.toBe(0);
  });
});
