import { describe, expect, it } from 'vitest';
import { matchDiscoveryRouteCandidate } from '../../src/kernel/discovery-lick-routing.js';

const alpha = { jid: 'cone-alpha', name: 'Alpha' };
const beta = { jid: 'cone-beta', name: 'Beta' };

describe('matchDiscoveryRouteCandidate', () => {
  it('routes to the cone whose recent user message mentions the discovery domain', () => {
    const messages = new Map<string, unknown[]>([
      [alpha.jid, [{ role: 'user', content: 'Please inspect example.com pricing' }]],
      [beta.jid, [{ role: 'user', content: 'Review the local test failures' }]],
    ]);

    expect(
      matchDiscoveryRouteCandidate(
        {
          discoveryOrigin: 'https://example.com',
          discoveryUrl: 'https://example.com/llms.txt',
        },
        [alpha, beta],
        (candidate) => messages.get(candidate.jid) ?? []
      )
    ).toBe(alpha);
  });

  it('considers URLs inside assistant tool calls and tool results', () => {
    const messages = new Map<string, unknown[]>([
      [alpha.jid, [{ role: 'assistant', content: 'I will inspect the other task.' }]],
      [
        beta.jid,
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                name: 'browser',
                arguments: { url: 'https://docs.acme.dev/guides/agents' },
              },
            ],
          },
          {
            role: 'toolResult',
            content: [{ type: 'text', text: 'Loaded docs.acme.dev' }],
          },
        ],
      ],
    ]);

    expect(
      matchDiscoveryRouteCandidate(
        {
          discoveryOrigin: 'https://docs.acme.dev',
          discoveryUrl: 'https://docs.acme.dev/llms.txt',
        },
        [alpha, beta],
        (candidate) => messages.get(candidate.jid) ?? []
      )
    ).toBe(beta);
  });

  it('uses URL path parts when the hostname alone is absent', () => {
    const messages = new Map<string, unknown[]>([
      [alpha.jid, [{ role: 'user', content: 'Open the frobnicator integration guide' }]],
      [beta.jid, [{ role: 'user', content: 'Open the payments integration guide' }]],
    ]);

    expect(
      matchDiscoveryRouteCandidate(
        { discoveryUrl: 'https://example.com/products/frobnicator/llms.txt' },
        [alpha, beta],
        (candidate) => messages.get(candidate.jid) ?? []
      )
    ).toBe(alpha);
  });

  it('returns no match for a tie or absent context so the caller can use its stable fallback', () => {
    const sameMessages = () => [{ role: 'user', content: 'Look at example.com' }];
    expect(
      matchDiscoveryRouteCandidate(
        { discoveryOrigin: 'https://example.com' },
        [alpha, beta],
        sameMessages
      )
    ).toBeUndefined();

    expect(
      matchDiscoveryRouteCandidate(
        { discoveryOrigin: 'https://unrelated.example' },
        [alpha, beta],
        () => []
      )
    ).toBeUndefined();
  });

  it('weights recent messages more heavily than older matches', () => {
    const messages = new Map<string, unknown[]>([
      [
        alpha.jid,
        [
          { role: 'user', content: 'Earlier we visited example.com' },
          { role: 'assistant', content: 'Now working on something unrelated' },
        ],
      ],
      [
        beta.jid,
        [
          { role: 'user', content: 'Earlier work was unrelated' },
          { role: 'assistant', content: 'I am opening example.com now' },
        ],
      ],
    ]);

    expect(
      matchDiscoveryRouteCandidate(
        { discoveryOrigin: 'https://example.com' },
        [alpha, beta],
        (candidate) => messages.get(candidate.jid) ?? []
      )
    ).toBe(beta);
  });

  it('anchors the newest message at the same recency weight for short and full histories', () => {
    const messages = new Map<string, unknown[]>([
      [alpha.jid, [{ role: 'user', content: 'I am opening example.com now' }]],
      [
        beta.jid,
        [
          ...Array.from({ length: 6 }, (_, index) => ({
            role: 'user',
            content: `Unrelated message ${index}`,
          })),
          { role: 'assistant', content: 'Earlier I visited example.com' },
          { role: 'assistant', content: 'Now working elsewhere' },
        ],
      ],
    ]);

    expect(
      matchDiscoveryRouteCandidate(
        { discoveryOrigin: 'https://example.com' },
        [alpha, beta],
        (candidate) => messages.get(candidate.jid) ?? []
      )
    ).toBe(alpha);
  });

  it('does not match a hostname embedded inside an unrelated hostname', () => {
    expect(
      matchDiscoveryRouteCandidate(
        { discoveryOrigin: 'https://ai.com' },
        [alpha, beta],
        (candidate) =>
          candidate === beta
            ? [{ role: 'assistant', content: 'I opened https://openai.com/docs' }]
            : []
      )
    ).toBeUndefined();
  });

  it('does not use fixed discovery artifact names as contextual clues', () => {
    expect(
      matchDiscoveryRouteCandidate(
        {
          discoveryOrigin: 'https://unrelated.example',
          discoveryUrl: 'https://unrelated.example/.well-known/ai-catalog.json',
        },
        [alpha, beta],
        (candidate) =>
          candidate === beta
            ? [
                {
                  role: 'user',
                  content: 'A previous discovery mentioned llms.txt and an AI catalog',
                },
              ]
            : []
      )
    ).toBeUndefined();
  });
});
