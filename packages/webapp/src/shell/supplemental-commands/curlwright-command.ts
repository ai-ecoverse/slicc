import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { CurlwrightBrowser } from './curlwright/run.js';

export function createCurlwrightCommand(browser: CurlwrightBrowser | null | undefined): Command {
  return defineCommand('curlwright', async (args, ctx) => {
    const { runCurlwright } = await import('./curlwright/run.js');
    return runCurlwright(browser, args, ctx);
  });
}
