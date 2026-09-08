/**
 * HAR recording subcommands: record, stop-recording.
 */

import { resolveAppTabId } from '../snapshot.js';
import { throwIfCallerGaveUp } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

/**
 * `record` is the one subcommand whose main side effect deliberately OUTLIVES
 * it: a recorder on a session of its own, so an LRU eviction of the tab's
 * registry entry cannot end a recording mid-flight. That also puts the
 * recorder's own round trips outside the tab handle's cancellation boundary,
 * so the steps around them are checked explicitly here.
 */
export const recordHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
  onTab,
  signal,
}) => {
  const url = positional[0] || 'about:blank';
  const filterCode = flags['filter'];
  await resolveAppTabId(browser, state);
  throwIfCallerGaveUp(signal, 'about to open the recording tab');
  const newTargetId = await browser.createPage(url);
  try {
    // The recorder's session is minted on the tab's own transport, which for a
    // tray target is that runtime's remote channel rather than whatever the
    // bridge last pointed at.
    const { transport, sessionId } = await onTab(newTargetId, async (page) => {
      const attachResult = await page.transport.send('Target.attachToTarget', {
        targetId: newTargetId,
        flatten: true,
      });
      return { transport: page.transport, sessionId: attachResult['sessionId'] as string };
    });
    if (!state.harRecorder) {
      state.harRecorder = browser.createHarRecorder(fs, transport);
    }
    const recordingId = await state.harRecorder.startRecording(
      newTargetId,
      sessionId,
      filterCode,
      signal
    );
    return {
      stdout: `Recording started (targetId: ${newTargetId}, recordingId: ${recordingId}) at ${url}\nHAR saved to /recordings/${recordingId}/\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    // The tab is this command's own side effect and nothing else references it
    // yet, so an abandoned `record` takes it with it rather than leaving a
    // stray tab behind. Closing is cleanup, not work: it runs after the abort
    // on purpose, and a failure here must not mask the reason we are unwinding.
    await browser.closePage(newTargetId).catch(() => undefined);
    throw err;
  }
};

export const stopRecordingHandler: PlaywrightHandler = async ({ state, positional }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'stop-recording requires a recordingId\n', exitCode: 1 };
  }
  const recordingId = positional[0];
  if (!state.harRecorder) {
    return { stdout: '', stderr: `Recording not found: ${recordingId}\n`, exitCode: 1 };
  }
  const recordingsPath = await state.harRecorder.stopRecording(recordingId);
  return {
    stdout: `Recording stopped. HAR files saved to ${recordingsPath}\n`,
    stderr: '',
    exitCode: 0,
  };
};
