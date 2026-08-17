/** Whether a name is a valid POSIX shell environment identifier. */
export function isValidShellEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
