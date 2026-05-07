/**
 * Per-scenario filesystem sandbox.
 *
 * `read_file` / `write_file` / `bash` tools resolve every path through
 * `Sandbox.resolve`, which canonicalises and rejects anything that
 * escapes the per-scenario tempdir root. The model can send absolute
 * paths (and almost always does) — those are reinterpreted as relative
 * to the sandbox root rather than refused, since refusing would
 * train-wreck most agent flows.
 */

import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';

export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = resolvePath(root);
    const stat = statSync(this.root);
    if (!stat.isDirectory()) {
      throw new Error(`sandbox root is not a directory: ${this.root}`);
    }
  }

  /**
   * Resolve `path` (model-supplied, possibly absolute) to an absolute
   * path inside the sandbox. Throws when the resolved path escapes.
   */
  resolve(path: string): string {
    // Strip any leading separator so the path is treated as relative
    // to the sandbox root rather than the host filesystem root.
    const stripped = path.replace(/^[/\\]+/, '');
    const absolute = resolvePath(this.root, stripped);
    const normalisedRoot = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (absolute !== this.root && !absolute.startsWith(normalisedRoot)) {
      throw new Error(`path ${JSON.stringify(path)} escapes the sandbox at ${this.root}`);
    }
    return absolute;
  }

  /**
   * Create a fresh sandbox under `os.tmpdir()`. Caller is responsible
   * for `dispose()` to remove it (the runner does this in a finally).
   */
  static create(label: string): Sandbox {
    const dir = mkdtempSync(`${tmpdir()}/slicc-eval-${label}-`);
    return new Sandbox(dir);
  }

  /** Recursive `mkdir -p` inside the sandbox. */
  mkdirInside(path: string): void {
    mkdirSync(this.resolve(path), { recursive: true });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
