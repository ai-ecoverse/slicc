/**
 * SLICC-shaped `AgentTool` definitions backed by typebox schemas.
 *
 * Mirrors the surface the cone agent sees in
 * `packages/webapp/src/tools/`: `read_file`, `write_file`, `bash`,
 * plus pure helpers (`calculator`, `is_prime`) for math-only scenarios.
 *
 * Tools are constructed against a `Sandbox` so file/bash calls can't
 * escape the per-scenario tempdir. There is intentionally no `chdir`
 * tool, no symlink follower, and no "bypass sandbox" escape — keep it
 * that way; if a future scenario needs broader access it should set
 * up the sandbox to contain what it needs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';

import type { Sandbox } from './sandbox.js';

// ── Schemas ─────────────────────────────────────────────────────────

const ReadFileSchema = Type.Object({
  path: Type.String({ description: 'Path inside the sandbox to read.' }),
});
const WriteFileSchema = Type.Object({
  path: Type.String({ description: 'Path inside the sandbox to write to.' }),
  content: Type.String({ description: 'UTF-8 text to write.' }),
});
const BashSchema = Type.Object({
  command: Type.String({ description: 'Bash command line to run from the sandbox root.' }),
});
const CalculatorSchema = Type.Object({
  expression: Type.String({
    description: "Arithmetic expression like '12*5' or '60*12'.",
  }),
});
// `n` is typed as a string here because Qwen 3.x routinely emits
// integer values as quoted strings when the schema says "integer".
// pi's typebox-based validator otherwise rejects the call, so accept
// the string and coerce in the handler. SLICC's real tool handlers
// are similarly lenient about this Qwen quirk.
const IsPrimeSchema = Type.Object({
  n: Type.Union([Type.Integer(), Type.String()], {
    description: 'A non-negative integer (may be passed as a quoted string).',
  }),
});

// ── Helpers ─────────────────────────────────────────────────────────

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated, +${s.length - max} chars]`;
}

// ── Filesystem tools (sandboxed) ────────────────────────────────────

export function makeReadFile(sandbox: Sandbox): AgentTool<typeof ReadFileSchema> {
  return {
    name: 'read_file',
    label: 'Read file',
    description: 'Read a UTF-8 text file from the sandbox. Returns the file contents.',
    parameters: ReadFileSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      const target = sandbox.resolve(params.path);
      if (!existsSync(target)) {
        return textResult(`error: file not found: ${params.path}`);
      }
      if (statSync(target).isDirectory()) {
        return textResult(`error: ${params.path} is a directory; use bash with 'ls'`);
      }
      return textResult(readFileSync(target, 'utf8'));
    },
  };
}

export function makeWriteFile(sandbox: Sandbox): AgentTool<typeof WriteFileSchema> {
  return {
    name: 'write_file',
    label: 'Write file',
    description:
      'Write a UTF-8 text file inside the sandbox, creating parent dirs as needed. Overwrites if the file exists.',
    parameters: WriteFileSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      const target = sandbox.resolve(params.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, params.content, 'utf8');
      // Earlier wording ("wrote N bytes") was easy to misread as
      // "maybe it didn't work, try again" — Qwen 3.6 35B looped this
      // 5+ times in the write_then_run scenario before the wording
      // was made loud and unambiguous.
      return textResult(
        `OK: file '${params.path}' was successfully written ` +
          `(${Buffer.byteLength(params.content, 'utf8')} bytes). ` +
          `The file now exists in the workspace and is ready to read or execute.`
      );
    },
  };
}

export function makeBash(sandbox: Sandbox): AgentTool<typeof BashSchema> {
  return {
    name: 'bash',
    label: 'Bash',
    description:
      'Run a bash command from the sandbox root. cwd is the sandbox; absolute paths reaching outside are rejected. ' +
      'Output is `exit=N\\n--- stdout ---\\n...\\n--- stderr ---\\n...` and is capped at 8 KB.',
    parameters: BashSchema,
    async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
      const result = spawnSync('bash', ['-lc', params.command], {
        cwd: sandbox.root,
        encoding: 'utf8',
        timeout: 10_000,
        // 1 MiB caps for stdout/stderr; we further clip the formatted
        // result below before sending it back to the model.
        maxBuffer: 1024 * 1024,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return textResult('error: command timed out after 10s');
      }
      if (result.error) {
        return textResult(`error: ${result.error.message}`);
      }
      const formatted =
        `exit=${result.status ?? -1}\n` +
        `--- stdout ---\n${result.stdout}` +
        `--- stderr ---\n${result.stderr}`;
      return textResult(clip(formatted, 8 * 1024));
    },
  };
}

// ── Pure helpers ────────────────────────────────────────────────────

export const calculatorTool: AgentTool<typeof CalculatorSchema> = {
  name: 'calculator',
  label: 'Calculator',
  description:
    "Evaluates a JavaScript-style arithmetic expression like '12*5' or '60*12'. Returns the numeric result as a string.",
  parameters: CalculatorSchema,
  async execute(_callId, params): Promise<ReturnType<typeof textResult>> {
    // Restricted: only digits, ops, parens, dots, whitespace. Anything
    // else short-circuits — we'd rather refuse than risk arbitrary JS
    // when the model gets clever with `eval`-bait expressions.
    if (!/^[\d\s+\-*/().%]+$/.test(params.expression)) {
      return textResult(`error: expression contains characters outside [\\d\\s+\\-*/().%]`);
    }
    try {
       
      const fn = new Function(`"use strict"; return (${params.expression});`);
      const value = fn();
      return textResult(String(value));
    } catch (err) {
      return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const isPrimeTool: AgentTool<typeof IsPrimeSchema> = {
  name: 'is_prime',
  label: 'Is prime',
  description: "Returns 'true' if the integer n is prime, 'false' otherwise.",
  parameters: IsPrimeSchema,
  async execute(
    _callId,
    params: Static<typeof IsPrimeSchema>
  ): Promise<ReturnType<typeof textResult>> {
    const n = typeof params.n === 'string' ? Number.parseInt(params.n, 10) : params.n;
    if (!Number.isFinite(n)) {
      return textResult(`error: n must be an integer; got ${JSON.stringify(params.n)}`);
    }
    if (n < 2) return textResult('false');
    const limit = Math.floor(Math.sqrt(n));
    for (let i = 2; i <= limit; i++) {
      if (n % i === 0) return textResult('false');
    }
    return textResult('true');
  },
};

// ── Tool subset selection ───────────────────────────────────────────

/**
 * Resolve a list of tool names into ready-to-use `AgentTool`s, drawing
 * filesystem tools from the per-scenario `Sandbox` and pure helpers
 * from this module's registry.
 */
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
