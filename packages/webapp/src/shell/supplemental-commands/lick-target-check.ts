import type { LickManagerSurface } from './lick-surface.js';

const MAX_LISTED_CANDIDATES = 12;

function describeCandidates(candidates: string[]): string {
  if (candidates.length === 0) return 'no cones or scoops are registered';
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
  const suffix = candidates.length > listed.length ? ', …' : '';
  return `valid targets: ${listed.join(', ')}${suffix}`;
}

export async function explicitLickTargetError(
  surface: Pick<LickManagerSurface, 'resolveLickTarget'> | null,
  command: string,
  target: string | undefined
): Promise<string | null> {
  if (!target || !surface) return null;
  let resolution: Awaited<ReturnType<LickManagerSurface['resolveLickTarget']>>;
  try {
    resolution = await surface.resolveLickTarget(target);
  } catch {
    return null;
  }
  if (resolution.status !== 'unresolved') return null;
  return (
    `${command}: --scoop "${target}" matches no live cone or scoop — ` +
    `its licks would be dropped (${describeCandidates(resolution.candidates)})\n`
  );
}
