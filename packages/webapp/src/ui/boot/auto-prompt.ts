/**
 * Auto-prompt: reads `?prompt=<text>` from the launch URL and submits it
 * as the first user message. Used by `node-server --prompt "..."` for
 * QA smoke-testing. The param is stripped after consumption so reloads
 * and copied URLs don't re-submit.
 *
 * @module
 */

/**
 * Extract the `prompt` query-param value from a URL search string and
 * strip it from the browser history so a page reload won't re-submit.
 *
 * Returns `null` when the param is absent or empty.
 */
export function consumeAutoPrompt(
  search: string,
  replaceState: (url: string) => void = (url) => globalThis.history?.replaceState(null, '', url)
): string | null {
  const params = new URLSearchParams(search);
  const prompt = params.get('prompt');
  if (!prompt) return null;

  params.delete('prompt');
  const remaining = params.toString();
  const cleaned = `${globalThis.location?.pathname ?? '/'}${remaining ? `?${remaining}` : ''}${globalThis.location?.hash ?? ''}`;
  replaceState(cleaned);

  return prompt;
}
