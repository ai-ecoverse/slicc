export function matchLickTargetAlias<T extends { name: string; folder: string }>(
  units: readonly T[],
  target: string
): T | undefined {
  return (
    units.find((u) => u.folder === target) ??
    units.find((u) => u.folder === `${target}-scoop`) ??
    units.find((u) => u.name === target)
  );
}
