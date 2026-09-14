import { resolveAppTabId } from '../snapshot.js';
import { throwIfCallerGaveUp } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

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
