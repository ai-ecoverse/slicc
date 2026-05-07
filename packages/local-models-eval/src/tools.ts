/**
 * SLICC-shaped `AgentTool` definitions backed by typebox schemas.
 *
 * The four FS/shell tools (`read_file`, `write_file`, `edit_file`,
 * `bash`) deliberately mirror SLICC's production tool *interfaces*
 * verbatim — same parameter names and JSON-Schema-equivalent types,
 * same descriptions, same result wording. The implementations are
 * different (sandbox-rooted Node FS instead of `VirtualFS`/`WasmShell`
 * in the browser), but the surface the model sees is byte-for-byte
 * identical, so any model quirk that breaks SLICC's tools — type
 * coercion, parameter ordering, error-string parsing — also breaks
 * the eval.
 *
 * The two pure helpers (`calculator`, `is_prime`) have no SLICC
 * counterpart; they exist for math-only scenarios. They use strict
 * typebox schemas, NOT the lenient Union workaround an earlier draft
 * had — pi-ai's `validateToolArguments` rejects a string where the
 * schema says integer, and SLICC's real tools would too. If a model
 * emits `"720"` instead of `720`, the eval should fail loudly, not
 * paper over it.
 *
 * SLICC sources mirrored here:
 *   - read_file/write_file/edit_file: packages/webapp/src/tools/file-tools.ts
 *   - bash:                            packages/webapp/src/tools/bash-tool.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';

import type { Sandbox } from './sandbox.js';

// ── Schemas ─────────────────────────────────────────────────────────
// Each schema is the typebox equivalent of the JSON Schema in
// `packages/webapp/src/tools/*.ts`. Type names match exactly:
// JSON Schema `"type": "number"` → `Type.Number()` (not Integer).
// Descriptions are copied verbatim so the model sees the same text.

const ReadFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to read.' }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-based). Optional.' })
  ),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read. Optional.' })),
});

const WriteFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to write.' }),
  content: Type.String({ description: 'The content to write to the file.' }),
});

const EditFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to edit.' }),
  old_string: Type.String({
    description: 'The exact string to find and replace. Must be unique in the file.',
  }),
  new_string: Type.String({ description: 'The replacement string.' }),
});

const BashSchema = Type.Object({
  command: Type.String({ description: 'The bash command to execute.' }),
});

const CalculatorSchema = Type.Object({
  expression: Type.String({
    description: "Arithmetic expression like '12*5' or '60*12'.",
  }),
});

// Strict Integer. Earlier drafts allowed Union[Integer, String] to
// paper over Qwen 3.x emitting `"720"` instead of `720`, but that
// hid exactly the type-coercion bug we want surfaced — SLICC's real
// tools would hit pi-ai's validateToolArguments rejection too.
const IsPrimeSchema = Type.Object({
  n: Type.Integer({ description: 'A non-negative integer.' }),
});

// ── Helpers ─────────────────────────────────────────────────────────

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { isError },
    isError,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated, +${s.length - max} chars]`;
}

// ── Filesystem tools (SLICC interface, sandboxed impl) ─────────────

export function makeReadFile(sandbox: Sandbox): AgentTool<typeof ReadFileSchema> {
  return {
    name: 'read_file',
    label: 'read_file',
    description:
      'Read the contents of a file. Returns the file content as a string with line numbers.',
    parameters: ReadFileSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      // Mirror SLICC: defaults are `offset = 1`, `limit = undefined`.
      const offset = params.offset ?? 1;
      const limit = params.limit;
      try {
        const target = sandbox.resolve(params.path);
        if (!existsSync(target)) {
          return textResult(`error: file not found: ${params.path}`, true);
        }
        if (statSync(target).isDirectory()) {
          return textResult(`error: ${params.path} is a directory`, true);
        }
        const content = readFileSync(target, 'utf8');
        const lines = content.split('\n');
        const startIdx = Math.max(0, offset - 1);
        const endIdx = limit !== undefined ? startIdx + limit : lines.length;
        const slice = lines.slice(startIdx, endIdx);
        const numbered = slice.map(
          (line, i) => `${String(startIdx + i + 1).padStart(6)} | ${line}`
        );
        return textResult(numbered.join('\n'));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}

export function makeWriteFile(sandbox: Sandbox): AgentTool<typeof WriteFileSchema> {
  return {
    name: 'write_file',
    label: 'write_file',
    description:
      'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created automatically.',
    parameters: WriteFileSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      try {
        const target = sandbox.resolve(params.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, params.content, 'utf8');
        // SLICC's exact result string. Earlier drafts used a "louder"
        // wording to try and break Qwen 3.6's write_file repetition
        // loop — that didn't help (multiple sampling iterations
        // confirmed it's a model issue, not a wording issue), and the
        // longer result drifted from the SLICC interface. Match
        // production.
        return textResult(`File written: ${params.path}`);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}

export function makeEditFile(sandbox: Sandbox): AgentTool<typeof EditFileSchema> {
  return {
    name: 'edit_file',
    label: 'edit_file',
    description:
      'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file. Use this instead of write_file when making targeted changes to existing files.',
    parameters: EditFileSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      try {
        const target = sandbox.resolve(params.path);
        if (!existsSync(target)) {
          return textResult(`error: file not found: ${params.path}`, true);
        }
        const content = readFileSync(target, 'utf8');
        const occurrences = content.split(params.old_string).length - 1;
        if (occurrences === 0) {
          return textResult(`old_string not found in ${params.path}`, true);
        }
        if (occurrences > 1) {
          return textResult(
            `old_string found ${occurrences} times in ${params.path}. It must be unique. Provide more context.`,
            true
          );
        }
        const newContent = content.replace(params.old_string, params.new_string);
        writeFileSync(target, newContent, 'utf8');
        return textResult(`File edited: ${params.path}`);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}

export function makeBash(sandbox: Sandbox): AgentTool<typeof BashSchema> {
  return {
    name: 'bash',
    label: 'bash',
    description:
      'Execute a bash command. Full shell with pipes, redirects, chaining, control flow. ' +
      'Includes: grep, rg, sed, awk, jq, find, curl, git, node, python3, sqlite3, ' +
      'open (--view for vision), playwright-cli (browser automation). Run `commands` for full list.',
    parameters: BashSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      const result = spawnSync('bash', ['-lc', params.command], {
        cwd: sandbox.root,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return textResult('error: command timed out after 10s', true);
      }
      if (result.error) {
        return textResult(`Shell error: ${result.error.message}`, true);
      }
      const exitCode = result.status ?? -1;
      // Mirror SLICC: concatenate stdout+stderr (no labels), or
      // synthesize "(exit code: N)" when both are empty.
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += result.stderr;
      if (!output) output = `(exit code: ${exitCode})`;
      return textResult(clip(output, 8 * 1024), exitCode !== 0);
    },
  };
}

// ── Pure helpers (no SLICC counterpart) ────────────────────────────

export const calculatorTool: AgentTool<typeof CalculatorSchema> = {
  name: 'calculator',
  label: 'calculator',
  description:
    "Evaluates a JavaScript-style arithmetic expression like '12*5' or '60*12'. Returns the numeric result as a string.",
  parameters: CalculatorSchema,
  async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
    if (!/^[\d\s+\-*/().%]+$/.test(params.expression)) {
      return textResult(`error: expression contains characters outside [\\d\\s+\\-*/().%]`, true);
    }
    try {
      const fn = new Function(`"use strict"; return (${params.expression});`);
      return textResult(String(fn()));
    } catch (err) {
      return textResult(`error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  },
};

export const isPrimeTool: AgentTool<typeof IsPrimeSchema> = {
  name: 'is_prime',
  label: 'is_prime',
  description: "Returns 'true' if the integer n is prime, 'false' otherwise.",
  parameters: IsPrimeSchema,
  async execute(
    _callId,
    params: Static<typeof IsPrimeSchema>
  ): Promise<ReturnType<typeof textResult>> {
    const n = params.n;
    if (n < 2) return textResult('false');
    const limit = Math.floor(Math.sqrt(n));
    for (let i = 2; i <= limit; i++) {
      if (n % i === 0) return textResult('false');
    }
    return textResult('true');
  },
};

// ── Tool subset selection ───────────────────────────────────────────

export function pickTools(names: ReadonlyArray<string>, sandbox: Sandbox | null): AgentTool<any>[] {
  const out: AgentTool<any>[] = [];
  for (const name of names) {
    switch (name) {
      case 'read_file':
        if (!sandbox) throw new Error("scenario asks for 'read_file' but has no sandbox");
        out.push(makeReadFile(sandbox));
        break;
      case 'write_file':
        if (!sandbox) throw new Error("scenario asks for 'write_file' but has no sandbox");
        out.push(makeWriteFile(sandbox));
        break;
      case 'edit_file':
        if (!sandbox) throw new Error("scenario asks for 'edit_file' but has no sandbox");
        out.push(makeEditFile(sandbox));
        break;
      case 'bash':
        if (!sandbox) throw new Error("scenario asks for 'bash' but has no sandbox");
        out.push(makeBash(sandbox));
        break;
      case 'calculator':
        out.push(calculatorTool);
        break;
      case 'is_prime':
        out.push(isPrimeTool);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
  return out;
}
