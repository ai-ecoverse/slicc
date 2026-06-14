/**
 * HAR recording subcommands: record, stop-recording.
 */

import { HarRecorder } from '../../../../cdp/index.js';
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
  const transport = browser.getTransport();
  const attachResult = await transport.send('Target.attachToTarget', {
    targetId: newTargetId,
    flatten: true,
  });
  const sessionId = attachResult['sessionId'] as string;
  if (!state.harRecorder) {
    state.harRecorder = new HarRecorder(transport, fs);
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
