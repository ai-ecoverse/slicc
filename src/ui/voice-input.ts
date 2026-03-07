/**
 * Voice Input — wraps the Web Speech API for hands-free message input.
 *
 * Uses webkitSpeechRecognition (Chrome built-in). Calls getUserMedia first
 * to ensure mic permission is granted (triggers Chrome's permission prompt).
 * Falls back to a popup window in extension mode if the side panel can't
 * get mic access directly.
 */

export interface VoiceInputOptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onStateChange: (state: 'idle' | 'listening' | 'error') => void;
  onError: (error: string) => void;
  autoSend: boolean;
  onAutoSend: (text: string) => void;
  onAutoDisable?: () => void;
  lang?: string;
}

// Web Speech API types — Chrome-specific, not in all TS libs
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string; readonly confidence: number };
}
interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent {
  readonly error: string;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access denied. Check Chrome site permissions.',
  'no-speech': 'No speech detected. Try again.',
  'audio-capture': 'No microphone found. Check your audio input device.',
  'network': 'Voice input requires an internet connection.',
  'aborted': 'Voice input was interrupted.',
  'service-not-available': 'Speech recognition service unavailable. Try again later.',
  'start-failed': 'Failed to start speech recognition.',
  'not-supported': 'Speech recognition is not supported in this browser.',
};

function isExtension(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export class VoiceInput {
  private recognition: SpeechRecognitionInstance | null = null;
  private _isListening = false;
  private shouldBeListening = false;
  private options: VoiceInputOptions;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTranscript = '';
  private consecutiveRestarts = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  // Extension popup fallback
  private messageListener: ((message: any) => void) | null = null;
  private popupWindowId: number | null = null;

  constructor(options: VoiceInputOptions) {
    this.options = options;
  }

  start(): void {
    if (this._isListening) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      this.options.onError('Speech recognition is not supported in this browser.');
      this.options.onStateChange('error');
      return;
    }

    this.shouldBeListening = true;
    this.pendingTranscript = '';
    this.consecutiveRestarts = 0;
    this.cancelAutoSend();
    this.resetInactivityTimer();

    // Try getUserMedia to ensure mic permission, then start recognition.
    // If getUserMedia fails in extension side panel, fall back to popup window.
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        for (const track of stream.getTracks()) track.stop();
        if (!this.shouldBeListening) return;
        this.startRecognition(new Ctor());
      }).catch((err: any) => {
        if (!this.shouldBeListening) return;
        if (isExtension()) {
          this.startExtensionPopup();
        } else {
          this.shouldBeListening = false;
          const name = err?.name;
          let message = ERROR_MESSAGES['not-allowed'];
          if (name === 'NotFoundError') {
            message = ERROR_MESSAGES['audio-capture'];
          } else if (name === 'NotReadableError') {
            message = 'Microphone is in use by another app. Try again.';
          }
          this.options.onError(message);
          this.options.onStateChange('error');
        }
      });
    } else {
      // No getUserMedia — try speech recognition directly
      this.startRecognition(new Ctor());
    }
  }

  // ---------- Extension fallback: popup window ----------

  private startExtensionPopup(): void {
    const lang = this.options.lang ?? 'en-US';
    const url = chrome.runtime.getURL(`voice-popup.html?lang=${encodeURIComponent(lang)}`);

    chrome.windows.create({
      url,
      type: 'popup',
      width: 300,
      height: 68,
      focused: true,
    }).then((win) => {
      if (!this.shouldBeListening) return; // user stopped while popup was opening
      this.setupExtensionListener();
      if (win?.id) this.popupWindowId = win.id;
    }).catch(() => {
      this.shouldBeListening = false;
      this.options.onError('Failed to open voice input window.');
      this.options.onStateChange('error');
    });
  }

  private setupExtensionListener(): void {
    if (this.messageListener) return;

    this.messageListener = (msg: any) => {
      if (msg.source !== 'voice-popup') return;

      switch (msg.type) {
        case 'speech-result':
          if (msg.isFinal) {
            this.pendingTranscript += (this.pendingTranscript ? ' ' : '') + msg.text;
            this.options.onTranscript(this.pendingTranscript, true);
            this.scheduleAutoSend();
          } else {
            const preview = this.pendingTranscript
              ? this.pendingTranscript + ' ' + msg.text
              : msg.text;
            this.options.onTranscript(preview, false);
            this.cancelAutoSend();
          }
          break;

        case 'speech-error': {
          const message = ERROR_MESSAGES[msg.error] ?? `Speech recognition error: ${msg.error}`;
          this.options.onError(message);
          if (msg.fatal) {
            this._isListening = false;
            this.shouldBeListening = false;
            this.popupWindowId = null;
            this.options.onStateChange('error');
          }
          break;
        }

        case 'speech-state':
          if (msg.state === 'listening') {
            this._isListening = true;
            this.options.onStateChange('listening');
          }
          break;

        case 'speech-end':
          this._isListening = false;
          this.shouldBeListening = false;
          this.popupWindowId = null;
          this.options.onStateChange('idle');
          break;
      }
    };

    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  private removeExtensionListener(): void {
    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }
  }

  // ---------- Direct speech recognition ----------

  private startRecognition(recognition: SpeechRecognitionInstance): void {
    this.recognition = recognition;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.options.lang ?? 'en-US';

    this.recognition.onresult = (event) => {
      this.consecutiveRestarts = 0; // got speech — reset backoff
      this.resetInactivityTimer(); // got speech — reset inactivity timeout
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        // Accumulate final transcript and reset the send timer.
        // If the user keeps talking, the timer resets each time a
        // final segment arrives, so the full utterance is sent together.
        this.pendingTranscript += (this.pendingTranscript ? ' ' : '') + finalTranscript;
        this.options.onTranscript(this.pendingTranscript, true);
        this.scheduleAutoSend();
      } else if (interimTranscript) {
        // Show accumulated + current interim
        const preview = this.pendingTranscript
          ? this.pendingTranscript + ' ' + interimTranscript
          : interimTranscript;
        this.options.onTranscript(preview, false);
        // User is still talking — cancel pending send
        this.cancelAutoSend();
      }
    };

    this.recognition.onerror = (event) => {
      const code = event.error;
      const message = ERROR_MESSAGES[code] ?? `Speech recognition error: ${code}`;

      if (code === 'no-speech') {
        this.options.onError(message);
        return;
      }

      if (code === 'aborted') return;

      this._isListening = false;
      this.shouldBeListening = false;
      this.options.onError(message);
      this.options.onStateChange('error');
    };

    this.recognition.onend = () => {
      this._isListening = false;
      // Clean up the old instance
      if (this.recognition) {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition = null;
      }
      if (this.shouldBeListening) {
        this.consecutiveRestarts++;
        // Backoff: 300ms, 600ms, 1200ms, ... up to 5s
        const delay = Math.min(300 * Math.pow(2, this.consecutiveRestarts - 1), 5000);
        const Ctor = getSpeechRecognitionConstructor();
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.shouldBeListening && Ctor) {
            this.startRecognition(new Ctor());
          } else if (this.shouldBeListening) {
            this.shouldBeListening = false;
            this.options.onStateChange('idle');
          }
        }, delay);
        return;
      }
      this.options.onStateChange('idle');
    };

    try {
      this.recognition.start();
      this._isListening = true;
      this.options.onStateChange('listening');
    } catch {
      this.shouldBeListening = false;
      this.options.onError('Failed to start speech recognition.');
      this.options.onStateChange('error');
    }
  }

  // ---------- Auto-send with delay ----------

  private static readonly SEND_DELAY_MS = 2500;
  private static readonly INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes

  private scheduleAutoSend(): void {
    this.cancelAutoSend();
    if (!this.options.autoSend) return;
    this.autoSendTimer = setTimeout(() => {
      this.autoSendTimer = null;
      const text = this.pendingTranscript.trim();
      if (text) {
        this.pendingTranscript = '';
        this.options.onAutoSend(text);
      }
    }, VoiceInput.SEND_DELAY_MS);
  }

  private cancelAutoSend(): void {
    if (this.autoSendTimer) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    if (!this.options.onAutoDisable) return;
    this.inactivityTimer = setTimeout(() => {
      this.inactivityTimer = null;
      this.stop();
      this.options.onAutoDisable?.();
    }, VoiceInput.INACTIVITY_TIMEOUT_MS);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // ---------- Shared ----------

  stop(): void {
    this.shouldBeListening = false;
    this.cancelAutoSend();
    this.clearInactivityTimer();
    this.pendingTranscript = '';
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.popupWindowId != null) {
      chrome.runtime.sendMessage({ target: 'voice-popup', type: 'voice-stop' });
      chrome.windows.remove(this.popupWindowId).catch(() => {});
      this.popupWindowId = null;
    } else if (this.recognition) {
      // Null out callbacks before stopping to prevent the async onend
      // from firing a stale onStateChange('idle') after we've already stopped.
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      try { this.recognition.stop(); } catch {}
      this.recognition = null;
    }

    this._isListening = false;
    this.options.onStateChange('idle');
  }

  toggle(): void {
    if (this._isListening || this.shouldBeListening) {
      this.stop();
    } else {
      this.start();
    }
  }

  isListening(): boolean {
    return this._isListening || this.shouldBeListening;
  }

  setAutoSend(enabled: boolean): void {
    this.options.autoSend = enabled;
  }

  destroy(): void {
    this.stop();
    this.removeExtensionListener();
    this.recognition = null;
  }
}

// localStorage keys for voice settings
const VOICE_STORAGE_KEYS = {
  autoSend: 'voice-auto-send',
  lang: 'voice-lang',
} as const;

export function getVoiceAutoSend(): boolean {
  const stored = localStorage.getItem(VOICE_STORAGE_KEYS.autoSend);
  return stored !== 'false'; // default true
}

export function setVoiceAutoSend(enabled: boolean): void {
  localStorage.setItem(VOICE_STORAGE_KEYS.autoSend, String(enabled));
}

export function getVoiceLang(): string {
  return localStorage.getItem(VOICE_STORAGE_KEYS.lang) || 'en-US';
}

export function setVoiceLang(lang: string): void {
  localStorage.setItem(VOICE_STORAGE_KEYS.lang, lang);
}
