export const EXECUTABLE_MODE = 0o755;
export const REGULAR_MODE = 0o644;

export function normalizeFileMode(mode: number | undefined): number {
  return mode !== undefined && (mode & 0o111) !== 0 ? EXECUTABLE_MODE : REGULAR_MODE;
}
