/**
 * JavaScript evaluation subcommands: eval, eval-file.
 */

import type { BrowserAPI } from '../../../../cdp/index.js';
import { requireTab } from '../state.js';
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
async function evaluateWithTopLevelAwait(browser: BrowserAPI, source: string): Promise<unknown> {
  try {
    return await browser.evaluate(source);
  } catch (rawErr) {
    if (!isSyntaxError(rawErr) || !mayUseTopLevelAwaitOrReturn(source)) throw rawErr;
    // Expression wrap — handles `await fetch(url).then(...)`.
    try {
      return await browser.evaluate(`(async () => (\n${source}\n))()`);
    } catch (exprErr) {
      if (!isSyntaxError(exprErr)) throw exprErr;
      // Statement wrap — handles multi-statement scripts with an explicit `return`.
      try {
        return await browser.evaluate(`(async () => {\n${source}\n})()`);
      } catch (stmtErr) {
        if (!isSyntaxError(stmtErr)) throw stmtErr;
        // All forms failed to parse — surface the original error, not a wrapper artifact.
        throw rawErr;
      }
    }
  }
}

export const evalHandler: PlaywrightHandler = async ({ browser, fs, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'eval requires an expression\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const expression = positional.join(' ');
  const output = await browser.withTab(tab.targetId, async () => {
    const evalResult = await evaluateWithTopLevelAwait(browser, expression);
    return typeof evalResult === 'string' ? evalResult : JSON.stringify(evalResult, null, 2);
  });
  if (flags['filename']) {
    await fs.writeFile(flags['filename'], output ?? 'null');
    return { stdout: `Result saved to ${flags['filename']}\n`, stderr: '', exitCode: 0 };
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
  const outputPath = flags['output'];

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
    const fileEvalResult = await evaluateWithTopLevelAwait(browser, scriptContent);
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
