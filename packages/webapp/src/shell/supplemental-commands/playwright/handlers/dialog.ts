/**
 * JavaScript dialog subcommands: dialog-accept, dialog-dismiss.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const dialogAcceptHandler: PlaywrightHandler = async ({
  browser,
  positional,
  flags,
  onTab,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const promptText = positional.length > 0 ? positional.join(' ') : undefined;
  await onTab(tab.targetId, async (page) => {
    await page.send('Page.enable');
    await page.send('Page.handleJavaScriptDialog', {
      accept: true,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  });
  return {
    stdout: `Accepted dialog${promptText ? ` with "${promptText}"` : ''}\n`,
    stderr: '',
    exitCode: 0,
  };
};

export const dialogDismissHandler: PlaywrightHandler = async ({ browser, flags, onTab }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await onTab(tab.targetId, async (page) => {
    await page.send('Page.enable');
    await page.send('Page.handleJavaScriptDialog', { accept: false });
  });
  return { stdout: 'Dismissed dialog\n', stderr: '', exitCode: 0 };
};
