// Spawn a handler script as a real child process so tests assert real exit codes
// (not just imported logic). The scripts live under .claude/skills/, force-added
// past .git/info/exclude.
// tva
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.claude/skills/slicc-lickback-handler/scripts'
);

/** Spawn a script to completion; resolves { code, stdout, stderr }. */
export function spawnScript(name, args = [], env = {}, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(SCRIPTS, name), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/** Spawn and return the live child (for long-running scripts like drain). */
export function spawnChild(name, args = [], env = {}) {
  const child = spawn('node', [join(SCRIPTS, name), ...args], { env: { ...process.env, ...env } });
  child.stderr.on('data', () => {});
  return child;
}
