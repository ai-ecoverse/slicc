/**
 * JavaScript evaluation subcommands: eval, eval-file.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

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
    const evalResult = await browser.evaluate(expression);
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
    const fileEvalResult = await browser.evaluate(scriptContent);
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
