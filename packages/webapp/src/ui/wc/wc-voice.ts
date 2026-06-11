/**
 * Voice input for the WC composer: a mic toggle in the composer-meta row
 * driving the legacy headless `VoiceInput` (Web Speech API). Final
 * transcripts append into the input card; with voice auto-send enabled the
 * utterance dispatches straight to the agent.
 */

import type { BootStageLogger } from '../boot/types.js';
import type { WcShellRefs } from './wc-shell.js';

const LISTENING_ATTR = 'data-listening';

/** Append a final transcript chunk to the input card's value. */
export function appendTranscript(inputCard: HTMLElement, text: string): void {
  const current = inputCard.getAttribute('value') ?? '';
  const joined = current && !current.endsWith(' ') ? `${current} ${text}` : current + text;
  inputCard.setAttribute('value', joined);
}

export interface WcVoiceDeps {
  refs: WcShellRefs;
  /** Dispatches an auto-sent utterance to the agent. */
  send(text: string): void;
  log: BootStageLogger;
}

export async function wireWcVoice(deps: WcVoiceDeps): Promise<void> {
  const { refs, send, log } = deps;
  const { getVoiceAutoSend, getVoiceLang, VoiceInput } = await import('../voice-input.js');

  const mic = document.createElement('slicc-icon-button');
  mic.setAttribute('icon', 'mic');
  mic.setAttribute('label', 'Voice input');
  refs.composerMeta.append(mic);

  const voice = new VoiceInput({
    onTranscript: (text, isFinal) => {
      if (isFinal && !getVoiceAutoSend()) appendTranscript(refs.inputCard, text);
    },
    onStateChange: (state) => {
      mic.toggleAttribute(LISTENING_ATTR, state === 'listening');
      mic.setAttribute('icon', state === 'listening' ? 'mic-off' : 'mic');
    },
    onError: (error) => log.warn('WC voice input error', { error }),
    autoSend: getVoiceAutoSend(),
    onAutoSend: (text) => send(text),
    lang: getVoiceLang(),
  });

  mic.addEventListener('click', () => {
    if (voice.isListening()) voice.stop();
    else voice.start();
  });
  window.addEventListener('beforeunload', () => voice.destroy(), { once: true });
}
