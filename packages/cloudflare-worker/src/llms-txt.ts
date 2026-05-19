/**
 * `GET /llms.txt` — markdown digest for LLM consumption (llmstxt.org spec).
 *
 * The format: H1 = name, blockquote = description, then sections of links.
 * SLICC uses this to advertise its discoverable surface (api-catalog,
 * handoff protocol, GitHub repo, docs) to coding agents that browse to
 * any SLICC endpoint.
 */

export function buildLlmsTxtResponse(request: Request): Response {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const body = `# SLICC

> SLICC is a persistent orchestration layer over LLM agents that runs in the
> browser. Agents can hand work off into a SLICC session via an RFC 8288
> \`Link\` header carrying a SLICC handoff or upskill rel.

## Public APIs

- [API catalog](${origin}/.well-known/api-catalog): RFC 9264 linkset of every public route on this host.
- [Handoff endpoint](${origin}/handoff): cross-agent handoff convenience URL.

## Handoff protocol

- [rel: handoff](${origin}/rel/handoff): free-form prose handoff to a SLICC session.
- [rel: upskill](${origin}/rel/upskill): install a skill from a public GitHub repo.

## Documentation

- [SLICC repository](https://github.com/ai-ecoverse/slicc): source, docs, releases.
- [Handoff protocol reference](https://github.com/ai-ecoverse/slicc/blob/main/docs/slicc-handoff.md)
- [Architecture overview](https://github.com/ai-ecoverse/slicc/blob/main/docs/architecture.md)
`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
