/** Default location used by the cone memory surface. */
export const MACHINE_WRITTEN_MEMORY_PATH = '/workspace/CLAUDE.md';

/** Minimal filesystem contract needed to install a machine-written memory document. */
export interface MachineWrittenMemoryFixtureTarget {
  writeFile(path: string, content: string): Promise<void>;
}

export type MachineWrittenMemoryVariant = 'multi-block' | 'consolidated';

const HEADER = '# Memory\n\n';

const SUBJECTS = [
  '**Evidence first:** inspect the smallest relevant surface before editing and record the observed state.',
  '**Narrow plans:** keep one measurable outcome, one implementation pass, and one verification pass.',
  '**Runtime state:** prefer browser-owned storage and keep the relay stateless whenever practical.',
  '**Failure boundaries:** external work needs a timeout, a useful error category, and an explicit retry decision.',
  '**Keyboard parity:** interactive rows remain focusable and respond to both `Enter` and `Space`.',
  '**Memory rendering:** preserve Markdown meaning while sanitizing untrusted tags at the DOM boundary.',
  '**Cross-runtime parity:** shared events need matching page, worker, extension, and follower handling.',
  '**Verification records:** report the exact command, outcome, and scope instead of writing only “tests pass”.',
  '**Synthetic data:** use neutral paths, reserved domains, and conspicuously invented identifiers in fixtures.',
  '**Collaboration:** coordinate public-barrel edits before overlapping with another active implementation.',
] as const;

const CONTEXTS = [
  'Keep the durable rule beside `packages/example.ts` so later work can reproduce the decision without a transcript.',
  'Preserve selection, expansion, and scroll state when a refresh replaces visible children.',
  'Run the focused regression first; broaden to package and repository gates only after the hypothesis holds.',
  'Treat A & B, “quoted labels”, arrows →, and `<preview mode="safe">` as text rather than executable markup.',
  'Prefer a reversible patch over a destructive command when the target was inferred rather than supplied.',
  'Stop exploring when another read no longer changes the hypothesis; switch to a test or focused question.',
  'Document the invalidation trigger when cached data can become stale, and retain a correctness bypass.',
  'Release every listener, timer, observer, channel, and object URL during the matching teardown path.',
  'Keep logs to operation name, duration, status, and a synthetic correlation label; omit payload contents.',
] as const;

const GENERATED_BULLETS = SUBJECTS.flatMap((subject) =>
  CONTEXTS.map((context) => `- ${subject} ${context}`)
);

const LONG_TAIL =
  'A long-lived panel decision was reviewed in sequence: a compact sample initially hid scale problems; a larger dataset exposed discarded provenance and summaries cut mid-phrase; Markdown stress then revealed literal markers; keyboard review found pointer-only activation; narrow layouts showed metadata competing with the primary text; refresh testing exposed lost search, focus, expansion, and scroll state; cross-runtime review found a missing follower path; failure testing identified an unbounded request; cleanup testing found a retained observer; and final verification required the focused test, package suite, coverage gate, and build. ';

const STRESS_BULLETS = [
  '- Keep diffs small.',
  '- Prefer native APIs.',
  '- Ship docs with code.',
  '- No surprise deploys.',
  '- **Continuation stress:** preserve one logical memory across source lines,\n  carrying `inline-code`, emphasis, and an arrow → without creating another row.',
  '- **Escaping stress:** render `<preview mode="safe">`, A & B, “quotes”, and `score > threshold` as inert content.',
  '- **Reserved link:** [the synthetic reference](https://example.invalid/memory) exists only to exercise link rendering.',
  '- **Medium tail:** before rebuilding a filtered collection, capture the query, focused control, selected row, group expansion, and scroll anchor; restore only state that still refers to surviving items.',
  `- **Long tail:** ${LONG_TAIL.repeat(2).trim()}`,
  '- **Folded long tail:** a remote action keeps one event contract and preserves error categories across serialization,\n  terminates pending requests on disconnect, and verifies timeout plus malformed-response behavior,\n  while this third source line remains part of the same bullet and contains “quotes”, A & B, and <angle brackets>.',
] as const;

const BULLETS = [...GENERATED_BULLETS, ...STRESS_BULLETS];

const APPEND_BLOCKS = [
  ['2099-01-03', 'compaction'],
  ['2099-01-10', 'new-session'],
  ['2099-01-18', 'compaction'],
  ['2099-02-02', 'pending-enrichment'],
  ['2099-02-14', 'new-session'],
  ['2099-03-01', 'compaction'],
  ['2099-03-21', 'pending-enrichment'],
  ['2099-04-05', 'compaction'],
  ['2099-04-19', 'new-session'],
  ['2099-05-07', 'compaction'],
] as const;

function renderAppendBlock(date: string, source: string, bullets: readonly string[]): string {
  return `## Auto-extracted (${date}, ${source})\n\n${bullets.join('\n')}\n`;
}

/** The pre-restructure shape emitted by repeated `appendConeMemory` calls. */
export const MACHINE_WRITTEN_MEMORY_MARKDOWN =
  HEADER +
  APPEND_BLOCKS.map(([date, source], index) =>
    renderAppendBlock(date, source, BULLETS.slice(index * 10, index * 10 + 10))
  ).join('\n');

/** The post-restructure shape required by `RESTRUCTURE_INSTRUCTION`. */
export const MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN = `${HEADER}## Auto-extracted (consolidated)\n\n${BULLETS.join('\n')}\n`;

/** Write either real writer shape to a filesystem-like target. */
export async function mountMachineWrittenMemoryFixture(
  target: MachineWrittenMemoryFixtureTarget,
  variant: MachineWrittenMemoryVariant = 'multi-block',
  path = MACHINE_WRITTEN_MEMORY_PATH
): Promise<void> {
  await target.writeFile(
    path,
    variant === 'consolidated'
      ? MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN
      : MACHINE_WRITTEN_MEMORY_MARKDOWN
  );
}
