export function consumeAutoPrompt(
  search: string,
  replaceState: (url: string) => void = (url) => globalThis.history?.replaceState(null, '', url)
): string | null {
  const params = new URLSearchParams(search);
  const prompt = params.get('prompt')?.trim();
  if (!prompt) return null;

  params.delete('prompt');
  const remaining = params.toString();
  const cleaned = `${globalThis.location?.pathname ?? '/'}${remaining ? `?${remaining}` : ''}${globalThis.location?.hash ?? ''}`;
  replaceState(cleaned);

  return prompt;
}
