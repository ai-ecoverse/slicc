/**
 * Parity + behavior tests for the dependency-free bedrock-camp compat
 * helpers.
 *
 * `bedrock-camp-compat.ts` exists so the eagerly loaded account-store
 * never imports the full provider (which drags pi-ai's compat layer
 * into the boot-critical eager graph). `bedrock-camp.ts` still carries
 * its own private copies of the same logic (it sits on the boy-scout
 * debt lists and cannot be edited piecemeal), so the parity block below
 * pins the two implementations to each other — if one is changed
 * without the other, these tests fail.
 */

import { describe, expect, it } from 'vitest';
import {
  isBedrockCampCompatible as providerIsCompatible,
  bedrockCampRegionFromBaseUrl as providerRegionFromBaseUrl,
} from '../../src/providers/built-in/bedrock-camp.js';
import {
  bedrockCampRegionFromBaseUrl,
  isBedrockCampCompatible,
} from '../../src/providers/built-in/bedrock-camp-compat.js';

describe('bedrockCampRegionFromBaseUrl', () => {
  it('extracts the region from standard, FIPS, and China runtime hosts', () => {
    expect(bedrockCampRegionFromBaseUrl('https://bedrock-runtime.us-west-2.amazonaws.com')).toBe(
      'us-west-2'
    );
    expect(
      bedrockCampRegionFromBaseUrl('https://bedrock-runtime-fips.us-east-1.amazonaws.com')
    ).toBe('us-east-1');
    expect(
      bedrockCampRegionFromBaseUrl('https://bedrock-runtime.cn-north-1.amazonaws.com.cn')
    ).toBe('cn-north-1');
  });

  it('returns null for missing, malformed, or non-Bedrock URLs', () => {
    expect(bedrockCampRegionFromBaseUrl(null)).toBeNull();
    expect(bedrockCampRegionFromBaseUrl(undefined)).toBeNull();
    expect(bedrockCampRegionFromBaseUrl('not a url')).toBeNull();
    expect(bedrockCampRegionFromBaseUrl('https://example.com')).toBeNull();
  });
});

describe('isBedrockCampCompatible', () => {
  it('accepts Claude 4.x on a region-matching inference profile', () => {
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(true);
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-sonnet-4-6' }, 'eu-central-1')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'global.anthropic.claude-haiku-4-5' }, 'us-east-1')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'apac.anthropic.claude-sonnet-4-6' }, 'ap-south-1')).toBe(
      true
    );
  });

  it('rejects region mismatches, bare model ids, and non-Claude-4 models', () => {
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(false);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-3-5-sonnet' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'us.amazon.nova-pro-v1' }, 'us-west-2')).toBe(false);
  });

  it('stays permissive when no region is configured yet', () => {
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' }, null)).toBe(true);
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' })).toBe(true);
  });
});

describe('parity with the private copies in bedrock-camp.ts', () => {
  const baseUrls = [
    'https://bedrock-runtime.us-west-2.amazonaws.com',
    'https://bedrock-runtime-fips.us-east-1.amazonaws.com',
    'https://bedrock-runtime.cn-north-1.amazonaws.com.cn',
    'https://example.com',
    'not a url',
    null,
    undefined,
  ];
  const cases: Array<{ id: string; region: string | null | undefined }> = [
    { id: 'us.anthropic.claude-opus-4-8', region: 'us-west-2' },
    { id: 'eu.anthropic.claude-sonnet-4-6', region: 'us-west-2' },
    { id: 'global.anthropic.claude-haiku-4-5', region: 'eu-central-1' },
    { id: 'apac.anthropic.claude-sonnet-4-6', region: 'ap-south-1' },
    { id: 'anthropic.claude-opus-4-8', region: 'us-west-2' },
    { id: 'us.anthropic.claude-3-5-sonnet', region: 'us-west-2' },
    { id: 'us.amazon.nova-pro-v1', region: 'us-west-2' },
    { id: 'eu.anthropic.claude-opus-4-8', region: null },
    { id: 'us.anthropic.claude-opus-5-0', region: 'us-east-1' },
  ];

  it('bedrockCampRegionFromBaseUrl matches on every case', () => {
    for (const url of baseUrls) {
      expect(bedrockCampRegionFromBaseUrl(url), String(url)).toBe(providerRegionFromBaseUrl(url));
    }
  });

  it('isBedrockCampCompatible matches on every case', () => {
    for (const { id, region } of cases) {
      expect(isBedrockCampCompatible({ id }, region), `${id} @ ${region}`).toBe(
        providerIsCompatible({ id }, region)
      );
    }
  });
});
