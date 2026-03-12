import { describe, it, expect } from 'vitest';
import { getApiProvider } from '@mariozechner/pi-ai/dist/api-registry.js';

// The side-effect import registers 'bedrock-camp-converse' in pi-ai's API registry.
// This is the same import that must appear in BOTH src/ui/main.ts AND
// src/extension/offscreen.ts — if either is missing, the provider won't be
// available in that runtime.
import './bedrock-camp.js';

describe('bedrock-camp provider registration', () => {
  it('registers bedrock-camp-converse in the API provider registry', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(provider).toBeDefined();
    expect(provider!.api).toBe('bedrock-camp-converse');
  });

  it('registers both stream and streamSimple functions', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(typeof provider!.stream).toBe('function');
    expect(typeof provider!.streamSimple).toBe('function');
  });
});
