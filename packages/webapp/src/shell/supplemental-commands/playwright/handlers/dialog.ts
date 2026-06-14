/**
 * JavaScript dialog subcommands: dialog-accept, dialog-dismiss.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const dialogAcceptHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const promptText = positional.length > 0 ? positional.join(' ') : undefined;
  await browser.withTab(tab.targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Page.enable', {}, sessionId!);
    await transport.send(
      'Page.handleJavaScriptDialog',
      {
        accept: true,
        ...(promptText !== undefined ? { promptText } : {}),
      },
      sessionId!
    );
  });
  return {
    stdout: `Accepted dialog${promptText ? ` with "${promptText}"` : ''}\n`,
    stderr: '',
    exitCode: 0,
  };
};

export const dialogDismissHandler: PlaywrightHandler = async ({ browser, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Page.enable', {}, sessionId!);
    await transport.send('Page.handleJavaScriptDialog', { accept: false }, sessionId!);
  });
  return { stdout: 'Dismissed dialog\n', stderr: '', exitCode: 0 };
};
