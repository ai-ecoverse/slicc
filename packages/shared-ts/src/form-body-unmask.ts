import type { SecretsPipeline } from './secrets-pipeline.js';

export type FormBodyUnmasker = Pick<SecretsPipeline, 'unmaskBody' | 'hasSecrets'>;

function decodeFormComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return null;
  }
}

function encodeFormComponent(value: string): string {
  return encodeURIComponent(value);
}

export function unmaskFormBody(
  pipeline: FormBodyUnmasker,
  body: string,
  hostname: string
): { text: string } {
  if (!body || !pipeline.hasSecrets()) return { text: body };

  let changed = false;
  const fields = body.split('&').map((field) => {
    const eq = field.indexOf('=');
    const name = eq < 0 ? '' : field.slice(0, eq + 1);
    const rawValue = eq < 0 ? field : field.slice(eq + 1);
    if (!rawValue) return field;

    const decoded = decodeFormComponent(rawValue);
    if (decoded === null) {
      const { text } = pipeline.unmaskBody(rawValue, hostname);
      if (text === rawValue) return field;
      changed = true;
      return `${name}${text}`;
    }

    const { text } = pipeline.unmaskBody(decoded, hostname);
    if (text === decoded) return field;
    changed = true;
    return `${name}${encodeFormComponent(text)}`;
  });

  return { text: changed ? fields.join('&') : body };
}
