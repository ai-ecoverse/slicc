import { isLickChannel, LICK_CHANNELS, type LickChannel } from './lick-channels.js';

export function unwrapMessageEnvelope(text: string): { sender: string; body: string } | null {
  if (!text.startsWith('[')) return null;
  const closeBracket = text.indexOf('] ');
  if (closeBracket <= 0) return null;

  if (text.lastIndexOf('\n', closeBracket) !== -1) return null;
  const afterBracket = text.slice(closeBracket + 2);

  const userPrefix = 'User: ';
  if (afterBracket.startsWith(userPrefix)) {
    return { sender: 'User', body: afterBracket.slice(userPrefix.length) };
  }
  for (const channel of LICK_CHANNELS) {
    const channelPrefix = `${channel}:`;
    if (!afterBracket.startsWith(channelPrefix)) continue;

    const nl = afterBracket.indexOf('\n');
    const firstLineEnd = nl === -1 ? afterBracket.length : nl;
    const firstLine = afterBracket.slice(0, firstLineEnd);

    let sepIdx = -1;

    const bracketIdx = firstLine.indexOf('[', channelPrefix.length);
    if (bracketIdx > channelPrefix.length) {
      sepIdx = firstLine.lastIndexOf(': ', bracketIdx);
    }
    if (sepIdx < channelPrefix.length) {
      sepIdx = afterBracket.indexOf(': ', channelPrefix.length);
    }
    if (sepIdx < 0 || sepIdx >= firstLineEnd) continue;
    const sender = afterBracket.slice(0, sepIdx);
    const body = afterBracket.slice(sepIdx + 2);
    return { sender, body };
  }

  const nl = afterBracket.indexOf('\n');
  const firstLineEnd = nl === -1 ? afterBracket.length : nl;
  const senderEnd = afterBracket.indexOf(': ');
  if (senderEnd <= 0 || senderEnd >= firstLineEnd) return null;
  const sender = afterBracket.slice(0, senderEnd);
  if (sender.includes('\n')) return null;
  return { sender, body: afterBracket.slice(senderEnd + 2) };
}

export function splitEnvelopes(text: string): Array<{ sender: string | null; body: string }> {
  if (text.length === 0) return [];
  const lines = text.split('\n');

  if (!lines[0].startsWith('[')) return [{ sender: null, body: text }];

  type Pending = { firstLine: string; rest: string[] } | null;
  const segments: Array<{ sender: string | null; body: string }> = [];
  let cur: Pending = null;

  const flush = () => {
    if (!cur) return;
    const joined = cur.rest.length > 0 ? `${cur.firstLine}\n${cur.rest.join('\n')}` : cur.firstLine;
    const env = unwrapMessageEnvelope(joined);
    if (env) {
      segments.push({ sender: env.sender, body: env.body });
    } else {
      segments.push({ sender: null, body: joined });
    }
    cur = null;
  };

  for (const ln of lines) {
    if (ln.startsWith('[') && /^\[[^\]\n]+\] /.test(ln) && ln.includes(': ')) {
      const provisional = unwrapMessageEnvelope(ln);
      if (provisional) {
        flush();
        cur = { firstLine: ln, rest: [] };
        continue;
      }
    }
    if (cur) cur.rest.push(ln);
    else cur = { firstLine: ln, rest: [] };
  }
  flush();

  if (segments.length === 0) return [{ sender: null, body: text }];
  return segments;
}

export function lickChannelFromSenderName(sender: string): LickChannel | null {
  const colon = sender.indexOf(':');
  if (colon <= 0) return null;
  const channel = sender.slice(0, colon);
  return isLickChannel(channel) ? channel : null;
}

export function lickChannelFromBody(body: string): LickChannel | null {
  const scoopMarker = /^\[@[^\]\s]+ (completed|idle)\]/.exec(body);
  if (scoopMarker) return scoopMarker[1] === 'idle' ? 'scoop-idle' : 'scoop-notify';
  if (/^\[@[^\]\s]+ sudo-request\]/.test(body)) return 'sudo-request';
  if (/^\[scoop_wait [^\]]+\]/.test(body)) return 'scoop-wait';
  if (body.startsWith('[Session Reload]')) return 'session-reload';
  return null;
}

export function lickIdFromBody(body: string): string | undefined {
  return /^(?:Lick ID|Request ID): (\S+)/m.exec(body)?.[1];
}
