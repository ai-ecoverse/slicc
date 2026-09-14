const PRIMING_NOTE =
  '◁This message has been sent through text to speech, consider possible ' +
  'phonetic alternatives and transcription errors. Future dictated messages ' +
  'will have the 🎙️ emoji appended. Your responses to dictated messages ' +
  'will be read out loud, avoid urls, acronyms, numbers, formatting. Begin ' +
  'every reply with the language you are replying in as a hidden HTML ' +
  'comment, e.g. <!--lang:en--> for English or <!--lang:de--> for German; ' +
  'it stays hidden from the user and selects a matching voice▷';

const MIC_RE = /\uD83C\uDF99\uFE0F?/g;

const NOTE_RE = /\u25C1[\s\S]*?\u25B7/g;

const REPLY_LANG_RE = /<!--\s*lang:\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\s*-->/i;
const REPLY_LANG_RE_G = /<!--\s*lang:\s*[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*\s*-->/gi;

let firstPending = true;

export function applyDictationMarkers(text: string, isFirst: boolean): string {
  const base = text.endsWith(' ') ? text : `${text} `;
  return isFirst ? `${base}\uD83C\uDF99\uFE0F${PRIMING_NOTE}` : `${base}\uD83C\uDF99\uFE0F`;
}

export function stripDictationMarkers(text: string): string {
  return text
    .replace(NOTE_RE, '')
    .replace(MIC_RE, '')
    .replace(/[ \t]+$/g, '')
    .trimEnd();
}

export function parseReplyLang(text: string): string | undefined {
  return REPLY_LANG_RE.exec(text)?.[1];
}

export function stripReplyLangMarker(text: string): string {
  return text.replace(REPLY_LANG_RE_G, '');
}

export function consumeDictationFirst(): boolean {
  if (!firstPending) return false;
  firstPending = false;
  return true;
}

export function resetDictationPriming(): void {
  firstPending = true;
}
