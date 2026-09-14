export interface SliccVersion {
  version: string;

  releasedAt: string | null;

  buildId: string;
}

export function readSliccVersion(): SliccVersion {
  return {
    version: __SLICC_VERSION__,
    releasedAt: __SLICC_RELEASED_AT__,
    buildId: __SLICC_BUILD_ID__,
  };
}

export type LastSeenVersionReader = () => Promise<string | null>;

let lastSeenVersionReader: LastSeenVersionReader | null = null;

export function setLastSeenVersionReader(reader: LastSeenVersionReader | null): void {
  lastSeenVersionReader = reader;
}

export function getLastSeenVersionReader(): LastSeenVersionReader | null {
  return lastSeenVersionReader;
}
