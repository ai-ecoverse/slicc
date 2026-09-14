import { requireTab, resolveFrame } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

function isSyntaxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SyntaxError/.test(msg);
}

function mayUseTopLevelAwaitOrReturn(source: string): boolean {
  return /\bawait\b/.test(source) || /\breturn\b/.test(source);
}

async function evaluateWithTopLevelAwait(
  evaluate: (source: string) => Promise<unknown>,
  source: string
): Promise<unknown> {
  try {
    return await evaluate(source);
  } catch (rawErr) {
    if (!isSyntaxError(rawErr) || !mayUseTopLevelAwaitOrReturn(source)) throw rawErr;

    try {
      return await evaluate(`(async () => (\n${source}\n))()`);
    } catch (exprErr) {
      if (!isSyntaxError(exprErr)) throw exprErr;

      try {
        return await evaluate(`(async () => {\n${source}\n})()`);
      } catch (stmtErr) {
        if (!isSyntaxError(stmtErr)) throw stmtErr;

        throw rawErr;
      }
    }
  }
}

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

export const evalHandler: PlaywrightHandler = async ({ browser, fs, positional, flags, onTab }) => {
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
  const output = await onTab(tab.targetId, async (page) => {
    const frame = await resolveFrame(page, flags);
    const evaluate = frame
      ? (source: string) => page.evaluateInFrame(frame.frameId, source, { world: 'main' })
      : (source: string) => page.evaluate(source);
    const evalResult = await evaluateWithTopLevelAwait(evaluate, expression);
    return typeof evalResult === 'string' ? evalResult : JSON.stringify(evalResult, null, 2);
  });

  if (outPath.path) {
    await fs.writeFile(outPath.path, output ?? 'null');
    return { stdout: `Result saved to ${outPath.path}\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: (output ?? 'undefined') + '\n', stderr: '', exitCode: 0 };
};

export const evalFileHandler: PlaywrightHandler = async ({
  browser,
  fs,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'eval-file requires a file path\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const scriptPath = positional[0];

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

  const fileOutput = await onTab(tab.targetId, async (page) => {
    const frame = await resolveFrame(page, flags);
    const evaluate = frame
      ? (source: string) => page.evaluateInFrame(frame.frameId, source, { world: 'main' })
      : (source: string) => page.evaluate(source);
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
