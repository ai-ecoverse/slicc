import { describe, expect, it } from 'vitest';
import {
  createLlmProxyFetchErrorResponse,
  formatLlmProxyFetchError,
} from '../../src/ui/llm-proxy-errors.js';

describe('llm-proxy-errors', () => {
  it('formats fetch failures for proxy error responses', () => {
    expect(formatLlmProxyFetchError(new TypeError('Failed to fetch'))).toBe(
      'LLM proxy fetch failed: Failed to fetch'
    );
  });

  it('creates tagged 502 responses for service worker proxy fetch failures', async () => {
    const response = createLlmProxyFetchErrorResponse(new TypeError('Failed to fetch'));

    expect(response.status).toBe(502);
    expect(response.headers.get('x-proxy-error')).toBe('1');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'LLM proxy fetch failed: Failed to fetch',
    });
  });
});
