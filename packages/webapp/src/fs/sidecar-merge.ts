export interface SidecarInodeJson {
  mode?: number;
  size?: number;
  ino?: number;
  data?: number;
  nlink?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  uid?: number;
  gid?: number;
}

export type SidecarEntries = { [path: string]: SidecarInodeJson };

export interface SidecarIndexJson {
  version?: number;
  maxSize?: number;
  entries?: SidecarEntries;
}

export interface SidecarDirtyState {
  paths: Set<string>;
  prefixes: Set<string>;
}

function isUnder(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(prefix === '/' ? '/' : `${prefix}/`);
}

export const SIDECAR_SELF_ENTRY = '/.metadata.json';

export function stripSidecarSelfEntry(doc: SidecarIndexJson): SidecarIndexJson {
  if (doc.entries) delete doc.entries[SIDECAR_SELF_ENTRY];
  return doc;
}

export function mergeSidecarEntries(
  onDisk: SidecarIndexJson,
  own: SidecarIndexJson,
  dirty: SidecarDirtyState
): SidecarIndexJson {
  const ownEntries = own.entries ?? {};
  const entries: SidecarEntries = { ...(onDisk.entries ?? {}) };

  if ('/' in ownEntries) entries['/'] = ownEntries['/'];

  for (const path of dirty.paths) {
    if (path in ownEntries) entries[path] = ownEntries[path];
    else delete entries[path];
  }

  for (const prefix of dirty.prefixes) {
    for (const key of Object.keys(entries)) {
      if (isUnder(key, prefix)) delete entries[key];
    }
    for (const key of Object.keys(ownEntries)) {
      if (isUnder(key, prefix)) entries[key] = ownEntries[key];
    }
  }

  const { entries: _ownEntries, ...ownRest } = own;

  return stripSidecarSelfEntry({ ...ownRest, entries });
}
