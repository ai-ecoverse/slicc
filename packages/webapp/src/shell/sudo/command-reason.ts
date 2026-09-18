import { normalizeSudoReason } from '../../sudo/reason.js';

export const SUDO_REASON_ENV = '__SLICC_SUDO_REASON';

const SHEBANG = /^#!/;

export function extractLeadingCommentReason(command: string): string {
  const parts: string[] = [];
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      if (parts.length > 0) break;
      continue;
    }
    if (!line.startsWith('#')) break;
    if (SHEBANG.test(line)) continue;
    const text = line.replace(/^#+/, '').trim();
    if (text) parts.push(text);
  }
  return normalizeSudoReason(parts.join(' '));
}
