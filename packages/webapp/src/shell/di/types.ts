export type DiSource = 'pyodide-cdn' | 'pypi';

export interface ResolvedPackage {
  name: string;

  version: string;

  source: DiSource;

  fileName: string;

  sha256: string;

  url: string;
}

export interface ParsedSpec {
  name: string;

  version?: string;
}
