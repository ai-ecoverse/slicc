/**
 * JavaScript evaluation subcommands: eval, eval-file.
 */

import { requireTab, resolveFrame } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

/** True when an evaluation error is a SyntaxError (parse-time, nothing executed). */
function isSyntaxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SyntaxError/.test(msg);
}

/**
 * Heuristic: does the source plausibly use top-level `await`/`return`? Those are
 * parse-time failures that execute nothing, so wrapping+retry is side-effect-safe.
 * Comment/string false-positives only cost a harmless extra parse attempt; the key
 * property is that inputs WITHOUT these tokens are never retried, so a runtime
 * SyntaxError thrown after side effects is surfaced without re-execution.
 */
function mayUseTopLevelAwaitOrReturn(source: string): boolean {
  return /\bawait\b/.test(source) || /\breturn\b/.test(source);
}

/**
 * Evaluate `source` in the page, transparently supporting top-level `await` /
 * `return` via an async-IIFE fallback. A plain expression / multi-statement
 * script is tried first (preserving last-expression completion values and
 * promise-returning expressions); only a *parse-time* SyntaxError on source that
 * plausibly uses top-level `await`/`return` triggers a retry. Source without
 * those tokens is never retried, so a runtime-thrown SyntaxError (e.g.
 * `JSON.parse('x')` after side effects, or `throw new SyntaxError(...)`) surfaces
 * the original error without re-executing any side-effecting code.
 */
async function evaluateWithTopLevelAwait(
  evaluate: (source: string) => Promise<unknown>,
  source: string
): Promise<unknown> {
  try {
    return await evaluate(source);
  } catch (rawErr) {
    if (!isSyntaxError(rawErr) || !mayUseTopLevelAwaitOrReturn(source)) throw rawErr;
    // Expression wrap — handles `await fetch(url).then(...)`.
    try {
      return await evaluate(`(async () => (\n${source}\n))()`);
    } catch (exprErr) {
      if (!isSyntaxError(exprErr)) throw exprErr;
      // Statement wrap — handles multi-statement scripts with an explicit `return`.
      try {
        return await evaluate(`(async () => {\n${source}\n})()`);
      } catch (stmtErr) {
        if (!isSyntaxError(stmtErr)) throw stmtErr;
        // All forms failed to parse — surface the original error, not a wrapper artifact.
        throw rawErr;
      }
    }
  }
}

/**
 * The output path from the `--filename`/`--output` aliases, or an error when
 * both are given — the two verbs historically used opposite precedence, so
 * an invocation passing both would write to different paths per verb.
 */
function resolveOutputPath(
  verb: string,
  flags: Record<string, string>
): { path: string | undefined } | { error: string } {
  const filename = flags['filename'];
  const output = flags['output'];
  if (filename !== undefined && output !== undefined) {
    return { error: `${verb}: --filename and --output are aliases — pass one, not both\n` };
  }
  return { path: filename ?? output };
}

export const evalHandler: PlaywrightHandler = async ({ browser, fs, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'eval requires an expression\n', exitCode: 1 };
  }
  const outPath = resolveOutputPath('eval', flags);
  if ('error' in outPath) {
    return { stdout: '', stderr: outPath.error, exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const expression = positional.join(' ');
  const output = await browser.withTab(tab.targetId, async () => {
    const frame = await resolveFrame(browser, flags);
    const evaluate = frame
      ? (source: string) => browser.evaluateInFrame(frame.frameId, source, { world: 'main' })
      : (source: string) => browser.evaluate(source);
    const evalResult = await evaluateWithTopLevelAwait(evaluate, expression);
    return typeof evalResult === 'string' ? evalResult : JSON.stringify(evalResult, null, 2);
  });
  // --output is accepted as an alias so eval and eval-file agree; before, the
  // manifest declared it here but only eval-file read it — `eval --output=…`
  // exited 0 with the file never written.
  if (outPath.path) {
    await fs.writeFile(outPath.path, output ?? 'null');
    return { stdout: `Result saved to ${outPath.path}\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: (output ?? 'undefined') + '\n', stderr: '', exitCode: 0 };
};

export const evalFileHandler: PlaywrightHandler = async ({ browser, fs, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'eval-file requires a file path\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const scriptPath = positional[0];
  // --filename is accepted as an alias so eval-file and eval agree.
  const resolved = resolveOutputPath('eval-file', flags);
  if ('error' in resolved) {
    return { stdout: '', stderr: resolved.error, exitCode: 1 };
  }
  const outputPath = resolved.path;

  let scriptContent: string;
  try {
    scriptContent = await fs.readTextFile(scriptPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `eval-file: cannot read ${scriptPath}: ${msg}\n`,
      exitCode: 1,
    };
  }

  const fileOutput = await browser.withTab(tab.targetId, async () => {
    const frame = await resolveFrame(browser, flags);
    const evaluate = frame
      ? (source: string) => browser.evaluateInFrame(frame.frameId, source, { world: 'main' })
      : (source: string) => browser.evaluate(source);
    const fileEvalResult = await evaluateWithTopLevelAwait(evaluate, scriptContent);
    return typeof fileEvalResult === 'string'
      ? fileEvalResult
      : JSON.stringify(fileEvalResult, null, 2);
  });

  if (outputPath) {
    const outputContent = fileOutput ?? 'null';
    await fs.writeFile(outputPath, outputContent);
    const sizeKB = Math.round(new TextEncoder().encode(outputContent).length / 1024);
    return {
      stdout: `Result saved to ${outputPath} (${sizeKB} KB)\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: (fileOutput ?? 'undefined') + '\n', stderr: '', exitCode: 0 };
};
