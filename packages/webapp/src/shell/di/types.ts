/**
 * Shared types for the `di` (alias `uv`) Python package manager command.
 *
 * `di` stages pure-Python / Pyodide wheels into the VFS and records them in
 * a minimal `pyproject.toml` + `uv.lock` pair. Two deterministic resolver
 * backends feed the same `ResolvedPackage` shape: the Pyodide CDN (when the
 * package is in `pyodide-lock.json`) and PyPI (everything else).
 */

/** Which backend a resolved wheel came from. Mirrors `uv.lock`'s `source`. */
export type DiSource = 'pyodide-cdn' | 'pypi';

/** A fully-resolved wheel ready to download, verify, and stage. */
export interface ResolvedPackage {
  /** Canonical package name as reported by the backend. */
  name: string;
  /** Exact resolved version. */
  version: string;
  /** Resolver backend that produced this entry. */
  source: DiSource;
  /** Wheel filename (already ends in `.whl`); the flat VFS staging basename. */
  fileName: string;
  /** Expected lowercase-or-mixed-case sha256 hex digest of the wheel bytes. */
  sha256: string;
  /** Absolute https URL the wheel bytes are fetched from. */
  url: string;
}

/** A parsed `di add` spec: a bare name, or `name@ver` / `name==ver`. */
export interface ParsedSpec {
  name: string;
  /** Exact version when the spec pinned one; otherwise `undefined` (latest). */
  version?: string;
}
