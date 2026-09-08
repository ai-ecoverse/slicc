/**
 * HAR recording subcommands: record, stop-recording.
 */

import { resolveAppTabId } from '../snapshot.js';
import type { PlaywrightHandler } from '../types.js';

export const recordHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
}) => {
  const url = positional[0] || 'about:blank';
  const filterCode = flags['filter'];
  await resolveAppTabId(browser, state);
  const newTargetId = await browser.createPage(url);
  // The recorder gets its OWN session, so an LRU eviction of the tab's
  // registry entry cannot end a recording mid-flight — but it is minted on
  // the tab's own transport, which for a tray target is that runtime's remote
  // channel rather than whatever the bridge last pointed at.
  const { transport, sessionId } = await browser.withTab(newTargetId, async (page) => {
    const attachResult = await page.transport.send('Target.attachToTarget', {
      targetId: newTargetId,
      flatten: true,
    });
    return { transport: page.transport, sessionId: attachResult['sessionId'] as string };
  });
  if (!state.harRecorder) {
    state.harRecorder = browser.createHarRecorder(fs, transport);
  }
  const recordingId = await state.harRecorder.startRecording(newTargetId, sessionId, filterCode);
  return {
    stdout: `Recording started (targetId: ${newTargetId}, recordingId: ${recordingId}) at ${url}\nHAR saved to /recordings/${recordingId}/\n`,
    stderr: '',
    exitCode: 0,
  };
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
