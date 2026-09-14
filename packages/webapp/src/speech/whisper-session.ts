import { createLogger } from '../base/logger.js';
import { decodeToMono16k } from './audio.js';
import type { WhisperAsr } from './whisper-engine.js';

const log = createLogger('speech:whisper-session');

const PARTIAL_INTERVAL_MS = 2000;

const TIMESLICE_MS = 500;

const FLUSH_TIMEOUT_MS = 5000;

const TRANSCRIBE_TIMEOUT_MS = 30000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

export interface WhisperSessionOptions {
  deviceId?: string;

  lang?: string;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;

  stream?: MediaStream;
}

export interface WhisperSessionHandle {
  stop(): Promise<string>;
  cancel(): void;
}

export function whisperLanguage(lang: string | undefined): string | undefined {
  const subtag = lang?.split('-')[0]?.toLowerCase();
  return subtag || undefined;
}

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
      audio:
        opts.deviceId && opts.deviceId !== 'default'
          ? { deviceId: { exact: opts.deviceId } }
          : true,
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

  let transcribeChain: Promise<string> = Promise.resolve('');
  const runTranscribe = (): Promise<string> => {
    const next = transcribeChain.catch(() => '').then(() => transcribeAccumulated());
    transcribeChain = next.catch(() => '');
    return next;
  };

  const partialTimer = setInterval(() => {
    if (partialBusy || stopped || chunks.length === 0) return;
    partialBusy = true;
    runTranscribe()
      .then((text) => {
        if (!stopped && text) opts.onPartial?.(text);
      })
      .catch((err) => {
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
      } catch {}
    }
    for (const track of stream.getTracks()) track.stop();
  };

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
      try {
        await withTimeout(flushRecorder(), FLUSH_TIMEOUT_MS, 'recorder flush');
        for (const track of stream.getTracks()) track.stop();

        return await withTimeout(runTranscribe(), TRANSCRIBE_TIMEOUT_MS, 'transcription');
      } catch (err) {
        for (const track of stream.getTracks()) track.stop();
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
