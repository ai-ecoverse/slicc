import {
  maxSatisfying as semverMaxSatisfying,
  satisfies as semverSatisfies,
  validRange as semverValidRange,
} from 'semver';

export function satisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range);
}

export function maxSatisfying(versions: string[], range: string): string | null {
  return semverMaxSatisfying(versions, range);
}

export function isValidRange(range: string): boolean {
  return semverValidRange(range) !== null;
}
