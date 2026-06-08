// packages/webapp/src/shell/supplemental-commands/workflow-script.ts
/** Pure helpers for the `workflow` command: meta parse, export strip, code assembly, sentinel split. */

/** Random per-run result token (a user console.log must not be able to spoof the result). */
export function makeSentinel(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const rnd =
    g.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `WF_RESULT_${rnd}`;
}

export interface WorkflowConfig {
  args?: unknown; // omitted (→ undefined in the realm) when absent — matches spec
  cap: number;
  budget: number | null;
  cwd: string;
  agentCwd: string; // constrained per-run scratch the command mkdir's before launch
  // NOTE: the result sentinel is NOT in __WF (user code could read/mutate it → spoof). It is
  // inlined as a string literal in the emit line by buildWorkflowCode (see below).
}

// Extracts name/description for the banner. `meta` is REQUIRED — Task 3's command errors if
// `name` is absent (CC parity). `meta.phases` titles are display-only and parsed in SP4 (no UI
// in SP1), so we intentionally don't extract them here.
export function parseMetaBanner(src: string): { name: string | null; description: string | null } {
  const block = extractMetaBlock(src);
  if (block === null) return { name: null, description: null };
  return {
    name: matchStringField(block, 'name'),
    description: matchStringField(block, 'description'),
  };
}

export function stripExports(src: string): string {
  return src.replace(/\bexport\s+(const|let|var|function|async\s+function|class)\b/g, '$1');
}

export function buildWorkflowCode(opts: {
  prelude: string;
  config: WorkflowConfig;
  body: string;
  sentinel: string;
}): string {
  // The sentinel is inlined as a LITERAL in the emit (NOT placed in __WF) so user code can neither
  // read nor mutate it. JSON.stringify drops `undefined`, so an absent `args` → `__WF.args === undefined`.
  return (
    // Capture console.log + JSON.stringify BEFORE user code so a script can't patch them to
    // intercept/forge the result. The sentinel is an unguessable literal (never in __WF).
    `const __emit = console.log.bind(console);\n` +
    `const __stringify = JSON.stringify.bind(JSON);\n` +
    `const __WF = ${JSON.stringify(opts.config)};\n` +
    `${opts.prelude}\n` +
    `const __r = await (async () => {\n${stripExports(opts.body)}\n})();\n` +
    `__emit(${JSON.stringify(opts.sentinel)} + __stringify(__r ?? null));\n`
  );
}

export function splitSentinel(
  stdout: string,
  sentinel: string
): { result: unknown; log: string; hadResult: boolean } {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(sentinel)) {
      const log = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/\n+$/, '');
      try {
        return { result: JSON.parse(lines[i].slice(sentinel.length)), log, hadResult: true };
      } catch {
        return { result: null, log, hadResult: true };
      }
    }
  }
  return { result: null, log: stdout.replace(/\n+$/, ''), hadResult: false };
}

function extractMetaBlock(src: string): string | null {
  const m = /\bmeta\s*=\s*\{/.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
}

function matchStringField(block: string, field: string): string | null {
  const m = new RegExp(`\\b${field}\\s*:\\s*(['"\\\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(block);
  return m ? m[2] : null;
}
