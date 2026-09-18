import type { ComputerDescriptor } from '@slicc/shared-ts';
import type { ComputerRegistry } from '../../../computers/registry.js';

export function resolveComputerId(
  registry: ComputerRegistry,
  query: string | undefined,
  env: Map<string, string>
): { id: string } | { error: string } {
  const list = registry.list();
  if (query) return matchQuery(list, query);
  const fromEnv = env.get('COMPUTER');
  if (fromEnv) return matchQuery(list, fromEnv);
  const last = registry.lastUsedId();
  if (last && registry.get(last)) return { id: last };
  if (list.length === 1) return { id: list[0].id };
  if (list.length === 0) {
    return {
      error:
        'no computers registered — `computer add tab <id>`, `computer add screen`, `computer add ssh <follower>`, `computer add url <http(s)://base>`, or `v86 start`',
    };
  }
  const ids = list.map((c) => c.id).join(', ');
  return { error: `which computer? pass -c <id> or \`computer use\`. registered: ${ids}` };
}

function matchQuery(list: ComputerDescriptor[], query: string): { id: string } | { error: string } {
  const exact = list.find((c) => c.id === query);
  if (exact) return { id: exact.id };
  const hits = list.filter(
    (c) =>
      c.id.endsWith(`:${query}`) ||
      c.title === query ||
      c.id === `v86:${query}` ||
      c.id === `tab:${query}` ||
      c.id === `screen:${query}` ||
      c.id === `ssh:${query}` ||
      c.id === `url:${query}`
  );
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) {
    return { error: `ambiguous computer '${query}' matches ${hits.map((c) => c.id).join(', ')}` };
  }
  const ids = list.map((c) => c.id).join(', ');
  return {
    error: `unknown computer '${query}'${ids ? ` — registered: ${ids}` : ' — none registered'}`,
  };
}
