/**
 * A push-to-talk dictation session on the whisper engine: capture the chosen
 * microphone with MediaRecorder, stream rolling partial transcripts while the
 * press is held, and produce the final transcript on release.
 *
 * Streaming: whisper has no incremental decoder, so partials are rolling
 * re-transcriptions — every `PARTIAL_INTERVAL_MS` the accumulated container
 * (header chunk + all data chunks, which keeps the webm decodable) is decoded
 * and transcribed in full, skipped while a previous partial is still in
 * flight. whisper-tiny keeps up with hold-to-talk utterance lengths; if a
 * pass falls behind, the next tick simply covers more audio.
 */

import { createLogger } from '../core/logger.js';
import { decodeToMono16k } from './audio.js';
import type { WhisperAsr } from './whisper-engine.js';

const log = createLogger('speech:whisper-session');

/** How often a rolling partial transcription is attempted. */
const PARTIAL_INTERVAL_MS = 2000;

/** MediaRecorder chunk granularity (keeps partials reasonably fresh). */
const TIMESLICE_MS = 500;

export interface WhisperSessionOptions {
  deviceId?: string;
  /** BCP-47 tag; whisper takes the bare language subtag ('en-US' → 'en'). */
  lang?: string;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  /** Pre-acquired microphone stream. When set, the session uses it directly
   *  instead of calling `getUserMedia` — the host already ran the leader
   *  permission surface under the PTT gesture and owns the grant. */
  stream?: MediaStream;
}

export interface WhisperSessionHandle {
  stop(): Promise<string>;
  cancel(): void;
}

/** 'en-US' → 'en'; whisper's language option wants the bare subtag. */
export function whisperLanguage(lang: string | undefined): string | undefined {
  const subtag = lang?.split('-')[0]?.toLowerCase();
  return subtag || undefined;
}

/**
 * Open the microphone and start a whisper dictation session. Rejects when
 * capture is unavailable (no getUserMedia / permission lost) — callers fall
 * back to the built-in recognizer.
 */
export async function startWhisperSession(
  asr: WhisperAsr,
  opts: WhisperSessionOptions
): Promise<WhisperSessionHandle> {
  let stream: MediaStream;
  if (opts.stream) {
    stream = opts.stream;
  } else {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('microphone capture unavailable in this realm');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true,
    });
  }

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const language = whisperLanguage(opts.lang);
  let partialBusy = false;
  let stopped = false;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const transcribeAccumulated = async (): Promise<string> => {
    if (chunks.length === 0) return '';
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const audio = await decodeToMono16k(await blob.arrayBuffer());
    return asr.transcribe(audio, { language });
  };

  const partialTimer = setInterval(() => {
    if (partialBusy || stopped || chunks.length === 0) return;
    partialBusy = true;
    transcribeAccumulated()
      .then((text) => {
        if (!stopped && text) opts.onPartial?.(text);
      })
      .catch((err) => {
        // A failed partial is non-fatal — the final pass still runs.
        log.warn('partial transcription failed', err);
      })
      .finally(() => {
        partialBusy = false;
      });
  }, PARTIAL_INTERVAL_MS);

  const teardownCapture = () => {
    clearInterval(partialTimer);
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const track of stream.getTracks()) track.stop();
  };

  /** Stop the recorder and resolve once its last chunk has flushed. */
  const flushRecorder = () =>
    new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') {
        resolve();
        return;
      }
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });

  recorder.start(TIMESLICE_MS);

  return {
    async stop(): Promise<string> {
      if (stopped) return '';
      stopped = true;
      clearInterval(partialTimer);
      await flushRecorder();
      for (const track of stream.getTracks()) track.stop();
      try {
        return await transcribeAccumulated();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.onError?.(`transcription failed: ${message}`);
        return '';
      }
    },
    cancel(): void {
      if (stopped) return;
      stopped = true;
      teardownCapture();
    },
  };
}
