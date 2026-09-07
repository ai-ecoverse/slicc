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
  isBedrockCampClaudeModel,
  isBedrockCampCompatible,
} from '../../src/providers/built-in/bedrock-camp-compat.js';
import { CLAUDE_FAMILIES, parseClaudeVersion } from '../../src/providers/claude-model-version.js';

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
  it('accepts Claude 4.x and newer on a region-matching inference profile', () => {
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

  // Regression: the filter used to hardcode `-4`, so every Claude 5 model was
  // silently dropped from the picker even though Bedrock serves it.
  it('accepts Claude 5 and the fable family', () => {
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-opus-5' }, 'us-west-2')).toBe(true);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-sonnet-5' }, 'us-west-2')).toBe(true);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-fable-5-1' }, 'us-west-2')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'global.anthropic.claude-fable-5' }, 'eu-central-1')).toBe(
      true
    );
    // Open-ended version group: a future generation needs no edit here.
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-opus-9' }, 'us-west-2')).toBe(true);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-opus-10' }, 'us-west-2')).toBe(true);
  });

  it('rejects region mismatches, bare model ids, and pre-4 or non-Claude models', () => {
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(false);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-3-5-sonnet' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-3-haiku' }, 'us-west-2')).toBe(false);
    expect(isBedrockCampCompatible({ id: 'us.amazon.nova-pro-v1' }, 'us-west-2')).toBe(false);
  });

  // Country-tier profiles. `au.anthropic.claude-opus-5` and
  // `jp.anthropic.claude-sonnet-4-6` were read from
  // `GET /inference-profiles` on ap-southeast-2 / ap-northeast-1.
  it('accepts the Japan and Australia country profiles in their own regions', () => {
    expect(
      isBedrockCampCompatible({ id: 'jp.anthropic.claude-sonnet-4-6' }, 'ap-northeast-1')
    ).toBe(true);
    expect(isBedrockCampCompatible({ id: 'jp.anthropic.claude-opus-4-8' }, 'ap-northeast-3')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'au.anthropic.claude-opus-5' }, 'ap-southeast-2')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'au.anthropic.claude-sonnet-5' }, 'ap-southeast-4')).toBe(
      true
    );
    // The continent tier stays available alongside them.
    expect(
      isBedrockCampCompatible({ id: 'apac.anthropic.claude-sonnet-4-6' }, 'ap-northeast-1')
    ).toBe(true);
  });

  // The country prefixes are NOT a `startsWith` on the region family: Seoul
  // (ap-northeast-2) and Singapore (ap-southeast-1) serve `apac.` only.
  it('does not leak jp./au. profiles into neighbouring ap- regions', () => {
    expect(
      isBedrockCampCompatible({ id: 'jp.anthropic.claude-sonnet-4-6' }, 'ap-northeast-2')
    ).toBe(false);
    expect(isBedrockCampCompatible({ id: 'au.anthropic.claude-opus-5' }, 'ap-southeast-1')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'jp.anthropic.claude-opus-4-8' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'au.anthropic.claude-opus-5' }, 'ap-northeast-1')).toBe(
      false
    );
  });

  // Non-Claude default-deny with a narrow, live-verified allowlist.
  it('accepts the allowlisted non-Claude models', () => {
    for (const id of [
      'global.openai.gpt-5.6-sol',
      'global.openai.gpt-5.6-terra',
      'global.openai.gpt-5.6-luna',
    ]) {
      expect(isBedrockCampCompatible({ id }, 'us-west-2'), id).toBe(true);
      // `global.` is reachable from every region.
      expect(isBedrockCampCompatible({ id }, 'ap-northeast-1'), id).toBe(true);
    }
  });

  // Everything else non-Claude stays denied — these are all callable on
  // Bedrock, so only the allowlist keeps them out.
  it('keeps every other non-Claude model out of the picker', () => {
    for (const id of [
      'us.amazon.nova-pro-v1:0',
      'us.meta.llama3-3-70b-instruct-v1:0',
      'us.deepseek.r1-v1:0',
      'us.writer.palmyra-x5-v1:0',
      'global.zai.glm-5',
      'global.minimax.minimax-m2.5',
      'us.qwen.qwen3-coder-480b-a35b-v1:0',
      // Functional on Bedrock but does not cache reliably (2/15), so it is
      // deliberately NOT allowlisted.
      'global.xai.grok-4.6',
      // Older/other versions of the allowlisted families are NOT covered.
      'global.xai.grok-4.3',
      'global.openai.gpt-5.5',
      'us.openai.gpt-oss-120b-1:0',
    ]) {
      expect(isBedrockCampCompatible({ id }, 'us-west-2'), id).toBe(false);
    }
  });

  // The allowlist is spelled out per variant, so a future catalogue addition
  // cannot slip into the picker without someone verifying its caching.
  it('does not auto-admit unverified gpt-5.6 variants or spellings', () => {
    for (const id of [
      'global.openai.gpt-5.6-nova',
      'global.openai.gpt-5.6-sol-preview',
      // Dash spelling: no Bedrock id uses it and it was never verified.
      'global.openai.gpt-5-6-sol',
      'global.openai.gpt-5.7-sol',
    ]) {
      expect(isBedrockCampCompatible({ id }, 'us-west-2'), id).toBe(false);
    }
  });

  it('still requires an inference-profile prefix for allowlisted models', () => {
    // Bare ids 400 with "on-demand throughput isn't supported".
    expect(isBedrockCampCompatible({ id: 'openai.gpt-5.6-sol' }, 'us-west-2')).toBe(false);
  });

  it('stays permissive when no region is configured yet', () => {
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' }, null)).toBe(true);
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-opus-4-8' })).toBe(true);
  });
});

// The Claude family set lives in two independent places: `CLAUDE_FAMILIES`
// (which builds the version parser used by the capability shims) and the
// picker's own `BEDROCK_CAMP_CLAUDE_RE`. Nothing at runtime couples them, so
// pin them here — a family added to the parser but not the picker would
// resolve correctly for temperature/caching and still never be selectable.
// `account-store.ts` clears `model.reasoning` for anything this returns false
// for, because effort control never reaches the wire off the Claude path.
describe('isBedrockCampClaudeModel', () => {
  it.each([
    ['us.anthropic.claude-opus-5'],
    ['global.anthropic.claude-sonnet-5'],
    ['us.anthropic.claude-fable-5'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0'],
  ])('is true for %s', (id) => {
    expect(isBedrockCampClaudeModel({ id })).toBe(true);
  });

  it.each([
    ['global.openai.gpt-5.6-sol'],
    ['global.openai.gpt-5.6-terra'],
    ['global.openai.gpt-5.6-luna'],
  ])('is false for the allowlisted non-Claude model %s', (id) => {
    // Still selectable — it just must not advertise a thinking-level control.
    expect(isBedrockCampCompatible({ id }, 'us-west-2'), id).toBe(true);
    expect(isBedrockCampClaudeModel({ id })).toBe(false);
  });
});

describe('picker family alternation covers every parsed Claude family', () => {
  it.each(CLAUDE_FAMILIES.map((f) => [f]))(
    'the picker accepts the %s family the version parser knows',
    (family) => {
      const id = `us.anthropic.claude-${family}-5`;
      expect(parseClaudeVersion(id), `${id} must parse`).not.toBeNull();
      expect(isBedrockCampCompatible({ id }, 'us-west-2'), `${id} must be selectable`).toBe(true);
    }
  );
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
    { id: 'us.anthropic.claude-opus-5', region: 'us-west-2' },
    { id: 'us.anthropic.claude-sonnet-5', region: 'us-west-2' },
    { id: 'us.anthropic.claude-fable-5-1', region: 'us-west-2' },
    { id: 'eu.anthropic.claude-opus-5', region: 'us-west-2' },
    { id: 'us.anthropic.claude-3-haiku', region: 'us-west-2' },
    { id: 'us.openai.gpt-5.6-sol', region: 'us-west-2' },
    { id: 'jp.anthropic.claude-sonnet-4-6', region: 'ap-northeast-1' },
    { id: 'jp.anthropic.claude-sonnet-4-6', region: 'ap-northeast-2' },
    { id: 'au.anthropic.claude-opus-5', region: 'ap-southeast-2' },
    { id: 'au.anthropic.claude-opus-5', region: 'ap-southeast-1' },
    { id: 'apac.anthropic.claude-sonnet-4-6', region: 'ap-northeast-1' },
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
