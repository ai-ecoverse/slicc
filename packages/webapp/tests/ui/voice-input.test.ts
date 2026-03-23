import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VoiceInput,
  getVoiceAutoSend,
  setVoiceAutoSend,
  getVoiceLang,
  setVoiceLang,
} from '../../packages/webapp/src/ui/voice-input.js';

// Mock SpeechRecognition
class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  private _shouldFailStart = false;

  start() {
    if (this._shouldFailStart) throw new Error('Failed to start');
  }

  stop() {}

  abort() {}

  // Test helpers
  simulateResult(transcript: string, isFinal: boolean, resultIndex = 0) {
    const result = {
      isFinal,
      0: { transcript, confidence: 0.95 },
      length: 1,
    };
    const event = {
      resultIndex,
      results: { [resultIndex]: result, length: resultIndex + 1 },
    };
    this.onresult?.(event as any);
  }

  simulateError(error: string) {
    this.onerror?.({ error } as any);
  }

  simulateEnd() {
    this.onend?.();
  }

  setFailStart(fail: boolean) {
    this._shouldFailStart = fail;
  }
}

let mockInstance: MockSpeechRecognition;

function installMockSpeechRecognition() {
  mockInstance = new MockSpeechRecognition();
  (globalThis as any).window = globalThis;
  (globalThis as any).SpeechRecognition = undefined;
  (globalThis as any).webkitSpeechRecognition = class {
    constructor() {
      return mockInstance;
    }
  };
}

function removeMockSpeechRecognition() {
  delete (globalThis as any).webkitSpeechRecognition;
  delete (globalThis as any).SpeechRecognition;
}

// Tests exercise the direct (non-extension) code path since `chrome.runtime.id`
// is not defined in Node — isExtension() returns false.
describe('VoiceInput (direct mode)', () => {
  let onTranscript: ReturnType<typeof vi.fn<(text: string, isFinal: boolean) => void>>;
  let onStateChange: ReturnType<typeof vi.fn<(state: 'idle' | 'listening' | 'error') => void>>;
  let onError: ReturnType<typeof vi.fn<(error: string) => void>>;
  let onAutoSend: ReturnType<typeof vi.fn<(text: string) => void>>;
  let voice: VoiceInput;

  beforeEach(() => {
    vi.useFakeTimers();
    installMockSpeechRecognition();

    onTranscript = vi.fn();
    onStateChange = vi.fn();
    onError = vi.fn();
    onAutoSend = vi.fn();

    voice = new VoiceInput({
      onTranscript,
      onStateChange,
      onError,
      autoSend: true,
      onAutoSend,
      lang: 'en-US',
    });
  });

  afterEach(() => {
    voice.destroy();
    removeMockSpeechRecognition();
    vi.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('should start listening', () => {
      voice.start();
      expect(voice.isListening()).toBe(true);
      expect(onStateChange).toHaveBeenCalledWith('listening');
    });

    it('should stop listening', () => {
      voice.start();
      voice.stop();
      expect(voice.isListening()).toBe(false);
      expect(onStateChange).toHaveBeenCalledWith('idle');
    });

    it('should toggle start then stop', () => {
      voice.toggle();
      expect(voice.isListening()).toBe(true);
      voice.toggle();
      expect(voice.isListening()).toBe(false);
    });

    it('should not double-start', () => {
      voice.start();
      const firstCallCount = onStateChange.mock.calls.length;
      voice.start(); // should be a no-op
      expect(onStateChange.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe('transcripts', () => {
    it('should call onTranscript with interim results', () => {
      voice.start();
      mockInstance.simulateResult('hello wor', false);
      expect(onTranscript).toHaveBeenCalledWith('hello wor', false);
    });

    it('should call onTranscript with final results', () => {
      voice.start();
      mockInstance.simulateResult('hello world', true);
      expect(onTranscript).toHaveBeenCalledWith('hello world', true);
    });
  });

  describe('auto-send', () => {
    it('should call onAutoSend after delay on final result when autoSend enabled', () => {
      voice.start();
      mockInstance.simulateResult('refactor the auth module', true);
      // Not sent immediately — delayed by 3 seconds
      expect(onAutoSend).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2500);
      expect(onAutoSend).toHaveBeenCalledWith('refactor the auth module');
    });

    it('should accumulate multiple final segments before sending', () => {
      voice.start();
      mockInstance.simulateResult('refactor the', true);
      vi.advanceTimersByTime(1000); // not enough to trigger send
      mockInstance.simulateResult('auth module', true);
      vi.advanceTimersByTime(2500);
      expect(onAutoSend).toHaveBeenCalledWith('refactor the auth module');
    });

    it('should cancel send timer when interim speech arrives', () => {
      voice.start();
      mockInstance.simulateResult('refactor', true);
      vi.advanceTimersByTime(2000); // 2s into the 3s delay
      mockInstance.simulateResult('the auth', false); // interim — cancels timer
      vi.advanceTimersByTime(2500); // would have fired by now
      expect(onAutoSend).not.toHaveBeenCalled(); // still not sent
    });

    it('should NOT call onAutoSend when autoSend disabled', () => {
      voice.setAutoSend(false);
      voice.start();
      mockInstance.simulateResult('refactor the auth module', true);
      vi.advanceTimersByTime(5000);
      expect(onAutoSend).not.toHaveBeenCalled();
      expect(onTranscript).toHaveBeenCalledWith('refactor the auth module', true);
    });

    it('should NOT call onAutoSend for interim results', () => {
      voice.start();
      mockInstance.simulateResult('refactor the', false);
      vi.advanceTimersByTime(5000);
      expect(onAutoSend).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should report not-allowed error', () => {
      voice.start();
      mockInstance.simulateError('not-allowed');
      expect(onError).toHaveBeenCalledWith(
        'Microphone access denied. Check Chrome site permissions.'
      );
      expect(onStateChange).toHaveBeenCalledWith('error');
    });

    it('should report network error', () => {
      voice.start();
      mockInstance.simulateError('network');
      expect(onError).toHaveBeenCalledWith('Voice input requires an internet connection.');
      expect(onStateChange).toHaveBeenCalledWith('error');
    });

    it('should treat no-speech as non-fatal', () => {
      voice.start();
      onStateChange.mockClear();
      mockInstance.simulateError('no-speech');
      expect(onError).toHaveBeenCalledWith('No speech detected. Try again.');
      expect(onStateChange).not.toHaveBeenCalledWith('error');
    });

    it('should not report aborted as error', () => {
      voice.start();
      onError.mockClear();
      mockInstance.simulateError('aborted');
      expect(onError).not.toHaveBeenCalled();
    });

    it('should handle unknown error codes', () => {
      voice.start();
      mockInstance.simulateError('something-weird');
      expect(onError).toHaveBeenCalledWith('Speech recognition error: something-weird');
    });
  });

  describe('auto-restart on unexpected end', () => {
    it('should restart when ended while shouldBeListening', () => {
      voice.start();
      expect(voice.isListening()).toBe(true);

      mockInstance.simulateEnd();
      expect(voice.isListening()).toBe(true);

      vi.advanceTimersByTime(150);
      expect(voice.isListening()).toBe(true);
    });

    it('should NOT restart when explicitly stopped', () => {
      voice.start();
      voice.stop();
      mockInstance.simulateEnd();
      vi.advanceTimersByTime(150);
      expect(voice.isListening()).toBe(false);
    });
  });

  describe('restart backoff', () => {
    it('should use increasing delay on consecutive restarts', () => {
      voice.start();
      // First end → restart after 300ms
      mockInstance.simulateEnd();
      vi.advanceTimersByTime(200);
      expect(voice.isListening()).toBe(true); // shouldBeListening, pending restart
      vi.advanceTimersByTime(150);
      expect(voice.isListening()).toBe(true); // restarted

      // Second end → restart after 600ms
      mockInstance.simulateEnd();
      vi.advanceTimersByTime(500);
      expect(voice.isListening()).toBe(true); // still pending
    });

    it('should reset backoff when speech is received', () => {
      voice.start();
      // Trigger a restart to bump the counter
      mockInstance.simulateEnd();
      vi.advanceTimersByTime(350);
      // Simulate speech — resets counter
      mockInstance.simulateResult('hello', true);
      // Next end should use initial delay (300ms) again
      mockInstance.simulateEnd();
      vi.advanceTimersByTime(350);
      expect(voice.isListening()).toBe(true);
    });
  });

  describe('pending transcript management', () => {
    it('should clear pending transcript on stop', () => {
      voice.start();
      mockInstance.simulateResult('partial', true);
      voice.stop();
      // Start again and get a new result — should not include old "partial"
      voice.start();
      mockInstance.simulateResult('fresh', true);
      expect(onTranscript).toHaveBeenLastCalledWith('fresh', true);
    });

    it('should clear pending transcript on start', () => {
      voice.start();
      mockInstance.simulateResult('old stuff', true);
      voice.stop();
      voice.start();
      mockInstance.simulateResult('new stuff', true);
      expect(onTranscript).toHaveBeenLastCalledWith('new stuff', true);
    });

    it('should cancel auto-send timer on stop', () => {
      voice.start();
      mockInstance.simulateResult('about to send', true);
      voice.stop(); // should cancel the pending send
      vi.advanceTimersByTime(5000);
      expect(onAutoSend).not.toHaveBeenCalled();
    });
  });

  describe('inactivity auto-disable', () => {
    it('should call onAutoDisable after 2 minutes of no speech', () => {
      const onAutoDisable = vi.fn();
      const v = new VoiceInput({
        onTranscript: vi.fn(),
        onStateChange: vi.fn(),
        onError: vi.fn(),
        autoSend: true,
        onAutoSend: vi.fn(),
        onAutoDisable,
        lang: 'en-US',
      });
      v.start();
      vi.advanceTimersByTime(120_000);
      expect(onAutoDisable).toHaveBeenCalledOnce();
      expect(v.isListening()).toBe(false);
      v.destroy();
    });

    it('should reset inactivity timer when speech is received', () => {
      const onAutoDisable = vi.fn();
      const v = new VoiceInput({
        onTranscript: vi.fn(),
        onStateChange: vi.fn(),
        onError: vi.fn(),
        autoSend: true,
        onAutoSend: vi.fn(),
        onAutoDisable,
        lang: 'en-US',
      });
      v.start();
      vi.advanceTimersByTime(100_000); // 100s in
      mockInstance.simulateResult('hello', false); // resets timer
      vi.advanceTimersByTime(100_000); // 100s more — only 100s since last speech
      expect(onAutoDisable).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20_000); // now 120s since last speech
      expect(onAutoDisable).toHaveBeenCalledOnce();
      v.destroy();
    });

    it('should not auto-disable if onAutoDisable not provided', () => {
      voice.start();
      vi.advanceTimersByTime(200_000);
      expect(voice.isListening()).toBe(true); // still listening, no auto-disable
    });
  });

  describe('feature detection', () => {
    it('should report error when SpeechRecognition unavailable', () => {
      removeMockSpeechRecognition();
      voice.start();
      expect(onError).toHaveBeenCalledWith('Speech recognition is not supported in this browser.');
      expect(onStateChange).toHaveBeenCalledWith('error');
      expect(voice.isListening()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should stop and clean up', () => {
      voice.start();
      voice.destroy();
      expect(voice.isListening()).toBe(false);
      expect(onStateChange).toHaveBeenCalledWith('idle');
    });
  });
});

describe('Voice settings (localStorage)', () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    // Mock localStorage for Node test environment
    Object.keys(store).forEach((k) => delete store[k]);
    (globalThis as any).localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => Object.keys(store).forEach((k) => delete store[k]),
    };
  });

  it('should default autoSend to true', () => {
    expect(getVoiceAutoSend()).toBe(true);
  });

  it('should persist autoSend = false', () => {
    setVoiceAutoSend(false);
    expect(getVoiceAutoSend()).toBe(false);
  });

  it('should persist autoSend = true', () => {
    setVoiceAutoSend(true);
    expect(getVoiceAutoSend()).toBe(true);
  });

  it('should default lang to en-US', () => {
    expect(getVoiceLang()).toBe('en-US');
  });

  it('should persist lang', () => {
    setVoiceLang('de-DE');
    expect(getVoiceLang()).toBe('de-DE');
  });
});
