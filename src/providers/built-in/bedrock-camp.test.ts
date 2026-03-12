import { describe, it, expect } from 'vitest';
import { getApiProvider } from '@mariozechner/pi-ai/dist/api-registry.js';

// The register() call in the built-in module registers 'bedrock-camp-converse'.
import { register, config } from './bedrock-camp.js';

// Call register manually since built-in modules use explicit registration
register();

describe('bedrock-camp built-in provider', () => {
  it('exports a valid ProviderConfig', () => {
    expect(config).toBeDefined();
    expect(config.id).toBe('bedrock-camp');
    expect(config.name).toBe('AWS Bedrock (CAMP)');
    expect(config.requiresApiKey).toBe(true);
    expect(config.requiresBaseUrl).toBe(true);
  });

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
