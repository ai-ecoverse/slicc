export function formatLlmProxyFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `LLM proxy fetch failed: ${message}`;
}

export function createLlmProxyFetchErrorResponse(error: unknown): Response {
  return new Response(JSON.stringify({ error: formatLlmProxyFetchError(error) }), {
    status: 502,
    statusText: 'Bad Gateway',
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Proxy-Error': '1',
    },
  });
}
