# S3 and DA Mount Backends — Design

**Date:** 2026-04-30
**Status:** Approved — implementation plan at `docs/superpowers/plans/2026-04-30-s3-da-mounts.md`
**Owner:** Karl Pauls

## Summary

Extend SLICC's `mount` command to support remote backends — Amazon S3 (and S3-compatible services such as Cloudflare R2) and Adobe da.live — alongside the existing local `FileSystemDirectoryHandle` mounts. Reads and writes flow through the VFS transparently; the agent's tools (`read_file`, `write_file`, `edit_file`, `bash`) need no awareness of the backend.

The driving workflow: the agent edits remote content as if it were local (publish-from-SLICC, direct DA edits, R2 asset management).

## Goals

- Mount S3 buckets / prefixes as VFS paths: `mount --source s3://bucket/prefix --profile <name> /mnt/s3`
- Mount da.live repos as VFS paths: `mount --source da://org/repo[/path] /mnt/da`
- Reuse the existing `mount`, `mount list`, `mount unmount`, `mount refresh` UX
- Single global cred set per backend per profile for v1; AWS-style profile selection lets a user switch credentials between mounts (e.g. one R2 profile + one AWS profile)
- Read-write from day one
- Dual-mode: works in CLI / Electron (via `/api/fetch-proxy`) and Chrome extension (direct fetch from both panel and offscreen shells)

## Non-goals (v1)

- Per-mount creds passed on the command line — security risk; selection is by `--profile` only
- AWS SSO, IAM Identity Center, EC2 IMDS-based auth — access keys only
- Pre-signed URL mounts
- Real-time invalidation (webhooks, S3 Events) — manual `mount refresh` only
- Streaming reads/writes for objects over the per-backend size limit
- Offline writes / queued writes
- Multi-IMS-identity DA mounts (single global IMS token reused from existing Adobe provider)

## Behavior

### Caching: TTL + ETag

Cache content per file: `{ path → body, etag, cachedAt }`. Default TTL: 30 s.

**Read flow:**

1. Cache hit, fresh (within TTL) → return cached body. Zero RTT.
2. Cache hit, stale → conditional `GET` with `If-None-Match: <etag>`.
   - 304 → bump `cachedAt`, return cached body. 1 RTT, zero body bytes.
   - 200 → replace `body + etag`, return new body.
3. Cache miss → unconditional `GET`. 200 → cache + return; 404 → throw `ENOENT`.

**Write flow:**

1. Existing file: `PUT` with `If-Match: <cached.etag>`.
2. New file: `PUT` with `If-None-Match: *` to refuse silent overwrite of a remote-side-created file.
3. On 412: refresh just that file's cache, throw `EBUSY` with hint to retry. **Never silent retry.**
4. On 200/201: extract new `ETag` from response, update cache, invalidate parent listing.

**Refresh:**

- Listing pass: re-walk the source from root (paginated `ListObjectsV2` for S3, recursive `/list` for DA) and diff the discovered paths against the cache (added / removed / changed-etag / unchanged).
- Body pass (only with `--bodies`): for paths with changed etags, conditional `GET` to refresh.
- A no-op refresh = one paginated S3 list (or one DA recursive walk) + zero body fetches.

### Profile-namespaced credentials

Selected via `--profile <name>`; defaults to `default`.

**S3 secrets** (per-profile namespace):

- `s3.<profile>.access_key_id` (required)
- `s3.<profile>.secret_access_key` (required)
- `s3.<profile>.region` (optional; default `us-east-1`)
- `s3.<profile>.endpoint` (optional; default: AWS host derived from region)
- `s3.<profile>.session_token` (optional; for STS temp creds)

**DA secrets:**

- v1: reuses the IMS token from the existing Adobe provider — no per-profile config required
- `--profile` accepted for symmetry; defaults to `default`. Multi-identity is v2.

Profile resolution happens at backend construction time. On 401/403, the backend re-resolves once (covers rotation) before bubbling `EACCES`.

### Command syntax

```
mount [--source <url>] [--profile <name>] [--no-probe] [--max-body-mb <n>] <target-path>
mount unmount [--clear-cache] <target-path>
mount list
mount refresh [--bodies] <target-path>
```

URL schemes:

- `s3://<bucket>/<prefix>` — bucket required, prefix optional
- `da://<org>/<repo>[/<path>]` — org and repo required, path optional
- No `--source` → existing local picker (unchanged)

Flags:

- `--no-probe` skips the mount-time `HEAD` bucket / `GET /list` round-trip.
- `--max-body-mb <n>` overrides the per-mount maximum body size.
- `--clear-cache` (on `unmount`) drops cached bodies/listings for that mount.
- `--bodies` (on `refresh`) forces conditional revalidation of all cached bodies.

Output behavior (a behavior change vs current `mount`):

- `mount` (success) — display name comes from `backend.describe().displayName` rather than today's `dirHandle.name` (which doesn't exist on remote backends). Local backend continues to derive display name from the picked directory's `name`; S3 derives from the bucket and prefix (e.g. `'my-bucket/prefix'`); DA from the org/repo (`'my-org/my-repo'`). Output format: `Mounted '<displayName>' → <path>` for local (preserves today's wording), `Mounted '<displayName>' → <path> (profile: <profile>)` for remote.
- `mount unmount` — keeps today's `Unmounted <path>`. With `--clear-cache`, appends `Cache cleared (<n> entries)`.
- `mount refresh` — replaces today's `Re-indexed <path>` with a structured summary derived from `RefreshReport`: `Refreshed <path>: +<added> -<removed> ~<changed> (<unchanged> unchanged, <errors> errors)`. Errors print on stderr, one per line, after the summary. Existing scripts/tests parsing the old `Re-indexed` string need updating; this is intentional (the old output had no information about what actually changed).

### Approval flow

Cone-initiated mounts always render an approval card. Backend-specific copy via `MountBackend.describeForApproval()`:

- **Local:** "Approve and select directory" + picker integration (existing)
- **S3:** "Approve mount of `s3://my-bucket/prefix` (profile `r2`)"
- **DA:** "Approve mount of `da://my-org/my-repo` using your IMS identity"

Scoop guard:

| Backend | Allowed in scoop? | Why                                   |
| ------- | ----------------- | ------------------------------------- |
| Local   | No (existing)     | Picker requires human at the keyboard |
| S3      | Yes (new)         | No UI; reads profile secrets          |
| DA      | Yes (new)         | No UI; reuses IMS token               |

The `isScoop?()` check moves out of `mount-commands.ts` and into `LocalMountBackend.create()`, so S3 and DA backends naturally allow scoop-initiated mounts.

## Architecture

### Approach

Refactor `VirtualFS.mount()` to accept a `MountBackend` instead of a raw `FileSystemDirectoryHandle`. The current FS Access logic moves into `LocalMountBackend`; `S3MountBackend` and `DaMountBackend` are peers. A shared `RemoteMountCache` provides TTL + ETag caching for both remote backends.

```
┌─────────────────────────────────────────────────────────┐
│ packages/webapp/src/fs/mount-commands.ts                │
│   parses --source / --profile, resolves profile         │
│   secrets, constructs the right backend, calls          │
│   VirtualFS.mount(targetPath, backend)                  │
└─────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│ packages/webapp/src/fs/virtual-fs.ts                    │
│   mount(targetPath, backend) → routes path-prefixed     │
│   ops (read/write/readdir/stat/mkdir/rm) to backend     │
└─────────────────────────────────────────────────────────┘
                             │
                             ▼
                  ┌──── MountBackend ────┐
                  │   (new central seam) │
                  └──────────┬───────────┘
        ┌─────────────────┬──┴──┬─────────────────┐
        ▼                 ▼     ▼                 ▼
  LocalMountBackend  S3MountBackend         DaMountBackend
  (FS Access API,    (HTTP + SigV4,         (HTTP + IMS bearer,
   wraps existing    bucket+prefix          org/repo+path
   handle code)      addressing)            addressing)
                          │                       │
                          └───────┬───────────────┘
                                  ▼
                        RemoteMountCache
                        (shared, TTL + ETag,
                         IDB store: slicc-mount-cache)
```

### File layout

New layout under `packages/webapp/src/fs/mount/`:

| File                   | Purpose                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `backend.ts`           | `MountBackend` interface + shared types (`MountDirEntry`, `MountStat`, `RefreshReport`)                                        |
| `backend-local.ts`     | Wraps the existing `FileSystemDirectoryHandle` logic — what `virtual-fs.ts` does today, lifted into a backend                  |
| `backend-s3.ts`        | S3 / S3-compatible implementation; uses `signing-s3.ts` and `remote-cache.ts`                                                  |
| `backend-da.ts`        | da.live implementation; uses IMS token from existing Adobe provider and `remote-cache.ts`                                      |
| `remote-cache.ts`      | TTL + ETag cache (`{dir → entries}`, `{file → body + etag + fetchedAt}`), IDB-persisted, shared by S3 + DA                     |
| `profile.ts`           | Profile resolution — reads `s3.<profile>.*` secrets, validates required fields, returns a typed `S3Profile` (or DA equivalent) |
| `signing-s3.ts`        | AWS SigV4 signer (pure function: request + creds → signed request). Web Crypto for HMAC. No AWS SDK dependency.                |
| `fetch-with-budget.ts` | Per-attempt timeout, retry budget, abort propagation. Shared by S3 and DA backends.                                            |

Modifications to existing files:

| File                    | Change                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `virtual-fs.ts`         | `mount(path, backend: MountBackend)` instead of `mount(path, handle)`. Mount table stores backends directly.                                                          |
| `mount-table-store.ts`  | Persist a `BackendDescriptor` (discriminated union), not the live backend. Local backend's `FileSystemDirectoryHandle` continues to be persisted separately as today. |
| `mount-recovery.ts`     | On session restore, dispatch on `kind` and reconstruct the backend (local: reactivate handle via popup; S3/DA: re-resolve profile, re-instantiate).                   |
| `mount-index.ts`        | Calls `backend.readDir()` instead of walking the handle directly.                                                                                                     |
| `mount-commands.ts`     | Parses `--source` and `--profile`; dispatches to backend constructors. Picker logic moves to `LocalMountBackend.create()`.                                            |
| `mount-picker-popup.ts` | No structural change — only invoked from `LocalMountBackend`.                                                                                                         |

### Boundary properties

- The mount table never sees backend internals — only the descriptor. The descriptor is what gets persisted across sessions.
- `RemoteMountCache` is the only stateful module shared between S3 and DA backends. Local backend doesn't touch it.
- Profile resolution captures the resolved profile at backend construction; re-resolves only on auth failure.
- SigV4 signing is a pure function — easy to unit-test against the AWS test vectors with no network.
- **`describe()` vs `describeForApproval()` usage rule.** `describe()` returns non-sensitive identifying information — `displayName` (always; e.g. picked dir's `name` for local, `'<bucket>/<prefix>'` for S3, `'<org>/<repo>'` for DA), `source` URI, `profile` name, optional `extra` — and is safe in any context: `mount list`, log lines, recovery prompts, telemetry, the `Mounted '<displayName>' → <path>` success line. `describeForApproval()` returns the user-facing approval-card copy plus picker-required flags and is invoked **only** at mount time when a `ToolUI` approval card is being rendered. Implementations must not let approval-card strings leak into non-interactive output paths.

### Stable mount identity

Each mount carries a stable `mountId: string` (UUID generated at mount creation, persisted in the descriptor). `RemoteMountCache` keys all entries by this id, so re-mounting at the same target path with a different source produces a fresh cache namespace and never collides with the prior mount's entries. Local mounts also carry a `mountId` for symmetry, even though the cache is unused.

### Cache key path convention

`RemoteMountCache` keys files and directories by **mount-relative paths** — i.e. `foo/bar.html`, not `/mnt/r2/foo/bar.html`. The reason is that two peers (panel + offscreen) sharing the same logical mount may have different VFS-absolute paths in flight at any moment if a rename or re-mount is racing, but the mount-relative path is unambiguous given a `mountId`. The key shape is therefore `(mountId, mountRelativePath)`, which is the same on both sides of the BroadcastChannel and across recovery. Backends translate VFS-absolute paths to mount-relative paths at the boundary (subtract the target prefix) before touching the cache.

### Backend close() lifecycle

`MountBackend.close()` is called once per unmount. Contract:

1. **Mark closed.** Subsequent calls into the backend (read/write/listing) throw `FsError('EBADF', 'mount closed')`.
2. **Abort in-flight ops.** The backend's internal AbortController is aborted; pending fetches reject with AbortError, which the call site converts to `EIO` or `EBADF` as appropriate.
3. **Drain.** `close()` awaits all pending op promises (resolved or rejected) before resolving, so `VirtualFS.unmount()` can safely tear down the mount-table entry afterwards.
4. **Release resources.** Cache instance is detached but cache entries persist in IDB until a `--clear-cache` unmount or natural TTL eviction.

Local backend's `close()` is a no-op aside from steps 1 and 3 (handle reactivation has no live network state).

### Key types

```ts
// backend.ts
export type MountKind = 'local' | 's3' | 'da';

export interface MountDirEntry {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  etag?: string; // remote backends only
  lastModified?: number; // ms epoch
}

export interface MountStat {
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
  etag?: string;
}

export interface RefreshReport {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  errors: { path: string; message: string }[];
}

export interface MountBackend {
  readonly kind: MountKind;
  readonly source: string | undefined;
  readonly profile?: string;

  readDir(path: string): Promise<MountDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;
  stat(path: string): Promise<MountStat>;
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  refresh(opts?: { bodies?: boolean }): Promise<RefreshReport>;
  describe(): { displayName: string; source?: string; profile?: string; extra?: string };
  describeForApproval(): {
    summary: string;
    needsPicker: boolean;
    pickerKind?: 'directory';
  };
  close(): Promise<void>;
}
```

`mkdir` on S3 and DA is a no-op — both APIs materialize paths on first write. `readDir` synthesizes intermediate directory entries from key prefixes.

```ts
// remote-cache.ts
export interface CachedListing {
  entries: MountDirEntry[];
  cachedAt: number;
}

export interface CachedBody {
  body: Uint8Array;
  etag: string;
  size: number;
  cachedAt: number;
}

export class RemoteMountCache {
  constructor(opts: { mountId: string; ttlMs: number; dbName?: string });

  getListing(dirPath: string): Promise<CachedListing | null>;
  putListing(dirPath: string, entries: MountDirEntry[]): Promise<void>;
  invalidateListing(dirPath: string): Promise<void>;

  getBody(filePath: string): Promise<CachedBody | null>;
  putBody(filePath: string, body: Uint8Array, etag: string): Promise<void>;
  invalidateBody(filePath: string): Promise<void>;

  clearMount(): Promise<void>;
  isStale(cachedAt: number, ttlMs?: number): boolean;
}
```

One IDB database (`slicc-mount-cache`), keyed by `mountId` so multiple mounts coexist. Bodies stored as `Uint8Array` (native — no base64 inflation).

```ts
// profile.ts
export interface S3Profile {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint?: string;
  pathStyle?: boolean; // v2 — default false (virtual-hosted)
}

export interface DaProfile {
  getBearerToken(): Promise<string>; // refreshes on demand via IMS launcher
  identity: string; // for `mount list` / approval card
}

export async function resolveS3Profile(name: string, secretStore: SecretStore): Promise<S3Profile>; // throws ProfileNotConfiguredError on missing required keys

export async function resolveDaProfile(name: string, ims: AdobeImsClient): Promise<DaProfile>;
```

```ts
// signing-s3.ts
export interface SigV4Request {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  url: URL;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export async function signSigV4(
  req: SigV4Request,
  creds: SigV4Credentials,
  region: string,
  service?: 's3',
  now?: Date // injectable for tests
): Promise<SigV4Request>;
```

```ts
// mount-table-store.ts
type BaseDescriptor = { mountId: string }; // stable UUID per mount
export type BackendDescriptor =
  | (BaseDescriptor & { kind: 'local'; idbHandleKey: string })
  | (BaseDescriptor & { kind: 's3'; source: string; profile: string })
  | (BaseDescriptor & { kind: 'da'; source: string; profile: string });

export interface MountTableEntry {
  targetPath: string;
  descriptor: BackendDescriptor;
  createdAt: number;
}
```

`mountId` is generated at mount creation (`crypto.randomUUID()`), persisted in the descriptor, and used as the `RemoteMountCache` namespace. Re-mounting at the same target with a different source produces a fresh `mountId` and therefore a fresh cache namespace, eliminating cross-source aliasing.

The descriptor is the recipe for rebuilding a backend on session restore — no live objects, no resolved secrets, no `Uint8Array`s.

### URL parsing

| Scheme  | Form                         | Required parts | Optional                                    |
| ------- | ---------------------------- | -------------- | ------------------------------------------- |
| `s3://` | `s3://<bucket>/<prefix>`     | bucket         | prefix (no leading/trailing `/` normalized) |
| `da://` | `da://<org>/<repo>[/<path>]` | org, repo      | path                                        |

Validation lives in `mount-commands.ts` before any backend is constructed; bad URLs fail with actionable errors before any network or secret read.

## Data flow

### 1. `mount --source s3://my-bucket/prefix --profile r2 /mnt/r2`

```
parse args  →  validate scheme & target  →  resolve profile (read secrets / IMS)
            →  construct backend           →  optional probe (HEAD bucket / GET /list)
            →  cone? → render approval card via describeForApproval(); deny → abort
            →  VirtualFS.mount(targetPath, backend)
                 ├─  add to in-memory mount table
                 ├─  persist BackendDescriptor in mount-table-store
                 └─  kick off MountIndex (background recursive readDir for fast walks)
            →  print mount summary
```

Probe is opt-out via `--no-probe`. Local backend skips probe entirely (the picker is the probe).

### 2. `read_file('/mnt/r2/foo.txt')` — TTL + ETag revalidation

```
cached = cache.getBody(filePath)

if cached && !cache.isStale(cached.cachedAt):     // inside TTL (30 s)
    return cached.body                              // zero RTT, zero bytes

if cached && cache.isStale(...):                   // outside TTL — revalidate
    GET <url>  with If-None-Match: cached.etag
      304  → bump cachedAt, return cached.body     // 1 RTT, zero bytes
      200  → cache.putBody(…), return new body     // 1 RTT, body bytes
      404  → cache.invalidateBody, throw ENOENT

if !cached:
    GET <url>                                      // first read, no conditional
      200  → cache.putBody(…), return body
      404  → throw ENOENT
      4xx auth → re-resolve profile & retry once; still failing → throw EACCES
```

URL construction:

- **S3 (virtual-hosted):** `https://<bucket>.<endpoint-host>/<prefix>/<filePath>` (AWS) or `https://<bucket>.<endpoint-host>/<prefix>/<filePath>` (R2 — same pattern, different host)
- **DA:** `https://admin.da.live/source/<org>/<repo>/<path>`

### 3. `write_file('/mnt/r2/foo.txt', body)` — conditional write

```
cached = cache.getBody(filePath)

PUT <url>  with body
  If-Match:     <cached.etag>   // if we have one
  If-None-Match: *              // if we don't (new file — refuse silent overwrite)

  200 / 201 →  newEtag = response.headers.get('etag')
               cache.putBody(filePath, body, newEtag)
               cache.invalidateListing(parentDir)   // size/etag changed
               return

  412 Precondition Failed →
               revalidate(filePath)                  // 1 conditional GET to refresh cache
               throw FsError('EBUSY',
                 'remote modified since last read — re-read and retry')

  4xx auth → re-resolve profile, retry once; throw EACCES on second failure
  5xx     → throw EIO with retry-after if header present
```

**412 policy: never silent retry.** We refresh the file's cache so the agent's _next_ read sees fresh content, then throw. The agent's `edit_file` retry loop naturally re-reads and re-edits — that's the right place for the conflict to surface, not buried inside the backend.

### 4. `mount refresh /mnt/r2`

```
listing pass — collect remote state:
    S3:
        keys = paginated ListObjectsV2(prefix=<source-prefix>)
               // no delimiter — flat list of every key under prefix
               → array of {key, etag, size, lastModified}
        // Synthesize directory structure client-side by splitting keys on '/'.
    DA:
        dirs = [<source-path>]
        while dirs not empty:
            dir = dirs.pop()
            entries = GET /list/<org>/<repo>/<dir>
            push any sub-directories from entries onto dirs
        // Collected entries have etags, sizes, types directly from the API.

diff against cache:
    remote_paths = set of all paths discovered in listing pass
    cache_paths  = paths the cache currently knows about (listings + bodies)

    for path in remote_paths:
        cached = cache.getBody(path)
        if not cached:                           added       (body left lazy)
        elif cached.etag != remote_etag(path):   changed     (cache.invalidateBody(path))
        else:                                    unchanged

    for path in cache_paths not in remote_paths:
        removed   (cache.invalidateBody(path) + cache.invalidateListing(path))

    // Rebuild listing cache from the fresh remote state, grouped by directory.
    for dir, entries in group_by_dir(remote_paths):
        cache.putListing(dir, entries)

body pass (only if --bodies flag):
    for each path marked 'changed':
        conditional GET → 304 (no-op) | 200 (refresh body + etag)

return RefreshReport { added, removed, changed, unchanged, errors }
```

A no-op refresh on a clean mount = one paginated S3 listing (or one DA recursive walk) + zero body fetches.

For very large S3 prefixes a flat `ListObjectsV2` walk is paid in full each refresh; if profiling shows this is too expensive in practice, v2 can switch to `delimiter='/'` per-cached-directory walking, but the diff logic stays the same.

### 5. `mount unmount /mnt/r2`

```
VirtualFS.unmount(path):
    remove from in-memory mount table
    delete persisted descriptor
    backend.close()        // abort in-flight requests, release listeners

optional --clear-cache flag:
    cache.clearMount()     // delete all listing+body entries for this mountId

default: keep cache (re-mount within TTL window is instant; entries expire by TTL anyway)
```

### 6. Session recovery

Recovery uses the existing API in `packages/webapp/src/fs/mount-recovery.ts` and `packages/webapp/src/ui/main.ts`:

```
// Input: entries: MountTableEntry[]   each is { targetPath, descriptor, createdAt }
// Output: { restored, needsRecovery } — both arrays of MountRecoveryEntry
recoverMounts(entries, sharedFs, log) {
    restored: MountRecoveryEntry[]      // for logs / observability; today's API only returns needsRecovery
    needsRecovery: MountRecoveryEntry[] // mounts that need user action

    for entry in entries:
        const { targetPath, descriptor } = entry
        try:
            let backend: MountBackend
            switch descriptor.kind:
                'local' → handle = loadFromIDB(descriptor.idbHandleKey)
                          // permission may have lapsed — handle reactivation requires
                          // user gesture, fall through to needsRecovery on PermissionError
                          backend = LocalMountBackend.fromHandle(handle)

                's3'    → profile = resolveS3Profile(descriptor.profile)
                          cache   = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 })
                          backend = new S3MountBackend({ source: descriptor.source, profile, cache })

                'da'    → profile = resolveDaProfile(descriptor.profile)
                          cache   = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 })
                          backend = new DaMountBackend({ source: descriptor.source, profile, cache })

            await sharedFs.mount(targetPath, backend)        // MountRecoveryFS.mount widens to take MountBackend
            restored.push(toRecoveryEntry(targetPath, descriptor))

        catch (err):
            log.warn(err)
            needsRecovery.push(toRecoveryEntry(targetPath, descriptor, err.message))
}

// `restored` is new in this design (today's recoverMounts only surfaces needsRecovery). It's used for
// logging — implementations that don't need it can keep the public return type as { needsRecovery }
// only. The pseudocode shows both for clarity.

// Caller in main.ts ~1749-1763 — already exists, dispatches via routeLickToScoop:
const entries = await getAllMountEntries();        // → MountTableEntry[]   (see prereq #4)
const { needsRecovery } = await recoverMounts(entries, sharedFs, log);
if (needsRecovery.length > 0) {
    const event: LickEvent = {
        type: 'session-reload',
        targetScoop: undefined,                    // routes to the cone
        timestamp: new Date().toISOString(),
        body: { reason: 'mount-recovery', mounts: needsRecovery },
    };
    routeLickToScoop(event);                       // not lickManager.fire — the actual API
}
// Cone renders the lick via formatLickEventForCone(event) (once prereq 5b lands),
// which dispatches mount-recovery to formatMountRecoveryPrompt(mounts) — the latter
// switches on kind to produce backend-specific copy. Until 5b lands, main.ts inlines
// this in its handler at lines 1620-1650; offscreen.ts only knows isUpgrade.
```

`MountRecoveryEntry` extends from today's `{ path, dirName }` to a discriminated shape:

```ts
export type MountRecoveryEntry =
  | { kind: 'local'; path: string; dirName: string }
  | { kind: 's3'; path: string; source: string; profile: string; reason: string }
  | { kind: 'da'; path: string; source: string; profile: string; reason: string };
```

`formatMountRecoveryPrompt` switches on `kind`:

- `local` → existing copy unchanged
- `s3` / `da` → "Couldn't restore mount `<path>` (`<source>`, profile `<profile>`) — `<reason>`. Run `mount --source <source> --profile <profile> <path>` to retry."

Recovery never auto-prompts the user mid-session. It populates `needsRecovery`, the `session-reload` lick fires once, and the cone surfaces an actionable card with the retry command pre-filled.

## Error handling

### Op-time taxonomy (`FsError`)

| Class                     | Source                               | `FsError` code              | Recovery path                                                    |
| ------------------------- | ------------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| Object not found          | 404 from S3/DA                       | `ENOENT`                    | None — agent handles like any missing file                       |
| Auth failure              | 401/403 after one retry              | `EACCES`                    | Recovery lick: "profile X invalid / IMS expired"                 |
| Concurrent write conflict | 412 (`If-Match` failed)              | `EBUSY` + hint              | Cache freshened for that path; agent re-reads next turn          |
| Body too large            | pre-flight `Content-Length` check    | `EFBIG`                     | Agent uses shell (`aws s3 cp`, etc.) out-of-band                 |
| Network / transient       | `AbortError`, 5xx, fetch reject      | `EIO`                       | One retry with backoff, then bubble                              |
| Mount unmounted mid-op    | targetPath removed during pending op | `EBADF`                     | Op aborts cleanly                                                |
| IDB quota exceeded        | `QuotaExceededError` on cache put    | (cache-only — not surfaced) | LRU evict 25% + retry once; still failing → warn + uncached read |

### Auth retry (S3 path)

```
fetchSigned(req):
    for attempt in 1..2:
        signed = signSigV4(req, profile.creds, region)
        res = await transport(signed)
        if attempt == 1 && res.status in (401, 403):
            profile = await resolveS3Profile(profileName)   // re-read secrets — covers rotation
            continue
        return res
    return res                                              // 2nd failure → caller throws EACCES
```

DA mirrors this; the second attempt calls `daProfile.getBearerToken()`, which delegates to the existing IMS launcher — covers expired-token without bouncing the user through a fresh OAuth flow if the refresh token still works.

### Network / 5xx retry

Single retry with jittered backoff for:

- `AbortError` (transient connection drop)
- 5xx responses (S3 returns 503 on hot keys)
- 429 with `Retry-After` (header always honored)

Beyond that, `EIO` bubbles. The agent's tool-call retry loop handles longer flakes.

### Body size limits

| Backend | Default `maxBodyBytes`   | Override                           |
| ------- | ------------------------ | ---------------------------------- |
| S3      | 25 MB                    | `--max-body-mb` flag at mount time |
| DA      | 5 MB (DA docs are small) | `--max-body-mb` flag               |

`readFile` checks size from listing metadata or a `HEAD` (cached) **before** issuing a body GET. Over-threshold → `EFBIG` immediately.

### IDB quota

`RemoteMountCache.putBody()` catches `QuotaExceededError`:

- LRU-evict 25% of the cache for this `mountId`
- Retry the put once
- Still failing → log warning, return without caching (read still completes)

Cache misses are not failures. The body was already read; we just couldn't memoize it.

### Mount-time errors (stderr, non-zero exit)

| Cause                 | Message                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Bad URL               | `mount: invalid source 's3foo' — expected s3://bucket[/prefix]`                                  |
| Profile missing       | `mount: profile 'r2' not configured. Set s3.r2.access_key_id and s3.r2.secret_access_key first.` |
| Profile incomplete    | `mount: profile 'r2' missing required field 'secret_access_key'`                                 |
| Probe failed          | `mount: probe failed for s3://bucket — 403 Forbidden. Check creds for profile 'r2'.`             |
| Target not empty      | (existing message — unchanged)                                                                   |
| Scoop + local backend | `mount: cannot mount local directories from a scoop (no UI). Ask the cone.`                      |

### Timeouts

Each fetch attempt gets its own AbortController; ops are bounded both per-attempt and overall.

| Operation                                     | Per-attempt timeout | Total op budget (with retries) |
| --------------------------------------------- | ------------------- | ------------------------------ |
| Read (`GET`)                                  | 15 s                | 30 s                           |
| Write (`PUT`/`POST`)                          | 30 s                | 60 s                           |
| Listing (`ListObjectsV2` page / DA `/list`)   | 20 s                | 40 s                           |
| Mount probe (`HEAD` bucket / DA `/list` root) | 10 s                | 15 s                           |
| Stat (`HEAD`)                                 | 10 s                | 20 s                           |

`fetch` doesn't separate connect from total — single AbortController + `setTimeout` is enough.

### Retry budgets

| Operation | Max attempts      | Retryable conditions                                  |
| --------- | ----------------- | ----------------------------------------------------- |
| Read      | 3 (1 + 2 retries) | network error, 5xx, 429, AbortError-from-timeout      |
| Write     | 2 (1 + 1 retry)   | same — ETag conditionals make writes safely retryable |
| Listing   | 3                 | same                                                  |
| Probe     | 1 (no retry)      | fail fast at mount time                               |
| Stat      | 2                 | same as read                                          |

Auth retry (1× on 401/403 after profile re-resolution) is **orthogonal** — it doesn't consume a network-retry slot.

### Why writes are safely retryable here

ETag conditionals make retry safe:

- Existing file: first PUT used `If-Match: e1`. Retry uses `If-Match: e1` again.
  - If first succeeded server-side, file now has etag `e2`, retry returns **412** — treat as success, reconcile cache. No double-write.
  - If first failed, retry returns **200** with new etag.
- New file: first PUT used `If-None-Match: *`. Retry same.
  - If first succeeded, retry returns **412** — same reconcile path.
  - If first failed, retry creates the file.

**412 has two meanings — distinguish them.** The retry path above treats 412 as "we already won this PUT," and silently reconciles the cache (with a `HEAD` to learn the new etag). That's only safe inside the retry branch where we know the first PUT was issued by us and may have actually landed.

The op-level 412 path (Section "Data flow → Write") is different — there, the first PUT failed cleanly with 412 because **another writer** changed the file between our last read and our PUT. We surface that to the agent as `EBUSY` so the edit loop can re-read.

Implementation rule: a 412 inside the bounded retry window of an in-flight PUT is reconciled silently; a 412 from a fresh first-attempt PUT is bubbled as `EBUSY`. Documented as a comment in the backend implementations so the distinction doesn't get collapsed.

### Backoff schedule

Full jitter, capped:

```
attempt 1 → no delay
attempt 2 → random(250 ms,  1000 ms)
attempt 3 → random(750 ms,  2500 ms)
```

`Retry-After` header overrides the schedule and is honored exactly, capped at the remaining op budget.

### AbortSignal threading

```
agent turn AbortController (outer)
   └── op AbortController              // per read/write/listing call
         └── attempt AbortController    // per fetch attempt; wired to per-attempt timeout
```

Outer abort → op aborts → in-flight fetch aborts. The backend re-throws as `FsError('EIO', 'aborted')` — no new error code.

### What we deliberately don't do

- No silent 412 handling on a user-facing first-attempt PUT — those bubble as `EBUSY` so the agent's edit loop can re-read. The transport-layer reconcile inside the bounded retry window (see "Why writes are safely retryable here") is a different case: there, a 412 means "we already won this PUT" and is silently reconciled. The two cases are distinguished by **whether the conflict comes from us or another writer** — bounded retry is always our own duplicate; first-attempt 412 is always external.
- No write batching / coalescing
- No background polling for staleness (TTL is read-driven)
- No offline mode with queued writes

## Dual-mode networking

| Float          | Strategy                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI / Electron | Signed request → `/api/fetch-proxy` (target via `X-Target-URL` header) → forwarded to S3/DA. Headers are preserved by the proxy already (only a small skip-set is dropped). The real risk is **body re-serialization** — the proxy currently `JSON.stringify`s anything `express.json()` parsed, which corrupts SigV4-signed PUT bodies. |
| Extension      | Direct `fetch()` from whichever shell context originated the call. Both contexts apply: the side-panel shell handles user-typed `mount` commands in the Terminal tab; the offscreen shell handles agent-tool-driven I/O. Manifest `host_permissions: <all_urls>` covers any S3 endpoint + da.live in both contexts.                      |

The fetch-proxy body issue requires a small upstream change to `packages/node-server/src/index.ts` (raw-body bypass) — tracked under Implementation prerequisites. Mount-time probe is the early-warning until that change is in: a `SignatureDoesNotMatch` from S3 fails the mount with a message pointing at the proxy.

## Testing

### Test layout

Mirrors the new `src/fs/mount/` structure:

```
packages/webapp/tests/fs/mount/
  backend-s3.test.ts             # S3 backend with mocked fetch
  backend-da.test.ts             # DA backend with mocked fetch
  backend-local.test.ts          # local backend (refactored from mount-commands.test.ts)
  remote-cache.test.ts           # TTL + ETag + IDB quota
  profile.test.ts                # secret resolution + error cases
  signing-s3.test.ts             # AWS SigV4 test vectors
  fetch-with-budget.test.ts      # timeout, retry, abort propagation
  mount-table-store.test.ts      # descriptor persistence (adapted)
  mount-recovery.test.ts         # backend reconstruction (adapted)
  mount-commands.test.ts         # flag parsing, dispatch, approval card (adapted)
  mount-index.test.ts            # backend.readDir-driven walk (adapted)
  virtual-fs.mount.test.ts       # VFS routing through MountBackend (adapted)
  virtual-fs-mount-sync.test.ts  # BroadcastChannel cross-instance sync (adapted)
  fixtures/
    sigv4-vectors/               # AWS test suite vectors (vendor copy)
    s3-listing-page-1.xml        # paginated LIST response fixtures
    s3-listing-page-2.xml
    da-list-response.json
  helpers/
    mock-fetch.ts                # hand-rolled fetch mock with response queue + assertion helpers
    fake-secret-store.ts         # in-memory SecretStore implementation
    fake-ims-client.ts           # in-memory IMS client returning a static bearer token
```

`fsa-test-helpers.ts` (existing) keeps serving the local backend tests unchanged.

### What gets mocked vs real

| Layer                        | Strategy                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP                         | **Mocked.** Hand-rolled `installFetchMock(...)` that intercepts `globalThis.fetch`, queues responses, and returns assertion helpers. No `msw` dependency.           |
| IDB                          | **fake-indexeddb** (already in use for VFS tests).                                                                                                                  |
| Web Crypto                   | **Real.** `globalThis.crypto.subtle` works under Node 22 and Vitest.                                                                                                |
| AbortController / setTimeout | **Real for abort, fake timers for backoff/timeout assertions** (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`).                                    |
| FileSystemDirectoryHandle    | **Existing fsa-test-helpers** for local backend tests.                                                                                                              |
| Secrets / IMS                | **Fake implementations** (`helpers/fake-secret-store.ts`, `helpers/fake-ims-client.ts`). Real implementations get integration coverage in their own existing tests. |

### Coverage targets (highlights)

**`signing-s3.test.ts`** — vendored AWS SigV4 v4 test suite. Each vector: input request + creds → assert canonical request, string-to-sign, signature byte-for-byte. **Non-negotiable.**

**`backend-s3.test.ts`** — at minimum:

- Cache-fresh read returns body without firing fetch
- TTL-expired read fires conditional GET with `If-None-Match`; 304 reuses cached body
- TTL-expired read; 200 replaces body and etag
- 404 throws `ENOENT` and invalidates body cache
- 401 → re-resolve profile → retry → 200 (assert profile re-read happened exactly once)
- Write to existing path uses `If-Match: <etag>`; 200 updates cache + invalidates parent listing
- Write to new path uses `If-None-Match: *`; 412 throws `EBUSY` with revalidated cache
- Paginated listing assembles correctly across pages; mid-stream failure preserves prior cache
- Body over `maxBodyBytes` throws `EFBIG` without firing the body GET

**`backend-da.test.ts`** — same matrix as S3 minus pagination, plus:

- Expired IMS token → `getBearerToken()` refreshes → second attempt succeeds
- Listing for nested directories triggers correct `/list/<org>/<repo>/<path>` calls

**`fetch-with-budget.test.ts`:**

- Per-attempt timeout fires AbortController with fake timers
- Retry count honored (1 read = up to 3 attempts)
- `Retry-After` header overrides backoff schedule
- Outer abort propagates to in-flight fetch
- Total op budget caps cumulative retry time

**`remote-cache.test.ts`:**

- TTL boundary: at `cachedAt + ttlMs - 1` fresh; at `cachedAt + ttlMs` stale
- IDB quota exceeded → LRU evicts 25% → retry succeeds
- `clearMount(mountId)` doesn't touch other mounts

**`mount-commands.test.ts`** (adapted):

- Bad URL produces actionable error
- Missing profile produces specific message naming the missing keys
- `--source s3://...` dispatches to `S3MountBackend`; same for `--source da://...`
- No `--source` → `LocalMountBackend` (existing path preserved)
- Cone-initiated mount renders backend-specific approval card (snapshot test)
- Scoop + local backend → fail-fast (existing); scoop + S3/DA → allowed (new)

**`mount-recovery.test.ts`** (adapted):

- Each descriptor `kind` reconstructs the right backend
- Failure during recovery fires recovery lick with the retry hint pre-filled
- Local recovery preserves existing handle-reactivation lick behavior

### Live-network tests (opt-in)

A separate `npm run test:live` (gated by env vars `SLICC_TEST_S3_PROFILE`, `SLICC_TEST_DA_PROFILE`) exercises a tiny real bucket / DA repo. **Excluded from CI.** Used to:

- Verify SigV4 against actual S3 / R2 endpoints (catches header-canonicalization bugs the fixtures might miss)
- Verify CLI `/api/fetch-proxy` doesn't strip signed headers
- Smoke-test before releases

### Pre-existing test migration

Each existing `tests/fs/mount-*.test.ts` file gets a paired migration in the same PR(s):

| Existing                        | Adaptation                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mount-commands.test.ts`        | Move local-only assertions into `backend-local.test.ts`; update top-level command tests for new flag parsing |
| `mount-recovery.test.ts`        | Generalize recovery assertions over backend descriptors                                                      |
| `mount-table-store.test.ts`     | Update for `BackendDescriptor` discriminated union shape                                                     |
| `virtual-fs.mount.test.ts`      | Replace direct `FileSystemDirectoryHandle` use with a fake `MountBackend`                                    |
| `virtual-fs-mount-sync.test.ts` | Same substitution; assertions about cache routing already test the right boundary                            |
| `mount-picker-popup.test.ts`    | Lives unchanged — only invoked from `LocalMountBackend.create()` now                                         |

Migration ships in the implementation PR(s), not as a follow-up.

## Implementation prerequisites

These are small upstream changes the design depends on. They land **inside the same PR(s)** as the backend code, but they are sequenced first so the rest of the work compiles and the test surfaces line up.

1. **Extend `FsErrorCode` in `packages/webapp/src/fs/types.ts`.** Today the type is closed at `ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY, EINVAL, EACCES, ELOOP`. The design adds:
   - `EBUSY` — 412 Precondition Failed (concurrent write conflict)
   - `EFBIG` — body exceeds `maxBodyBytes` (pre-flight check)
   - `EBADF` — operation issued against an unmounted/closed backend
   - `EIO` — network failure, 5xx, AbortError-from-timeout
     Implementer must audit code that branches on `FsError` / `FsErrorCode`. Today's actual consumers (search results, not guesses):
   - `packages/webapp/src/fs/restricted-fs.ts` — extensive errno branching
   - `packages/webapp/src/fs/virtual-fs.ts` — many `throw new FsError(...)` sites including `convertFsaError`
   - `packages/webapp/src/shell/vfs-adapter.ts` — `instanceof FsError && err.code === 'ENOENT'` check + `EISDIR` throws
   - `packages/webapp/src/shell/supplemental-commands/playwright-command.ts` — `EEXIST` check
   - `packages/webapp/src/scoops/agent-bridge.ts` — `isFsErrorCode` helper plus call sites
     (No `FsError` references under `packages/webapp/src/tools/` — earlier mention of that directory was wrong.)

2. **Change the `BroadcastChannel('vfs-mount-sync:<db>')` message shape.** Today (`virtual-fs.ts:62-90`) the channel posts `{ type: 'mount' | 'unmount', path, handle }` where `handle` is a `FileSystemDirectoryHandle` (structured-cloneable). Remote backends are not cloneable, so the message must carry the descriptor instead:

   ```ts
   { type: 'mount', path, descriptor: BackendDescriptor } // descriptor.mountId is the cache key
   { type: 'unmount', path }
   ```

   Receiving peers reconstruct the backend per-context: local → `loadFromIDB(descriptor.idbHandleKey)` (same path as recovery), S3/DA → re-resolve profile and instantiate, with each peer's `RemoteMountCache` pointing at the same shared IDB store keyed by `descriptor.mountId`. Cross-peer cache writes are inherently best-effort because IDB writes from one peer aren't atomically visible to another mid-op; the TTL window absorbs short divergences. Two peers writing the same file is a multi-writer scenario already governed by ETag conditionals.

3. **Extend `MountRecoveryEntry` in `packages/webapp/src/fs/mount-recovery.ts`.** Today: `{ path, dirName }`. Required shape:

   ```ts
   export type MountRecoveryEntry =
     | { kind: 'local'; path: string; dirName: string }
     | { kind: 's3'; path: string; source: string; profile: string; reason: string }
     | { kind: 'da'; path: string; source: string; profile: string; reason: string };
   ```

   `formatMountRecoveryPrompt` switches on `kind`; existing local copy stays unchanged. The `session-reload` lick payload (`{ reason: 'mount-recovery', mounts }`) is unchanged at the lick level — only the entry shape grows.

   **Audit list — call sites that bind to today's narrow `{ path, dirName }` shape:**
   - `packages/webapp/src/ui/main.ts:1629-1637` — the `event.body as { reason?: string; mounts?: Array<{ path: string; dirName: string }> }` cast in the cone-side renderer must widen to the new union.
   - `formatMountRecoveryPrompt` itself — body needs a `switch (kind)` instead of unconditional `dirName` access.
   - Any tests that assert the prompt copy or build mock recovery entries (`mount-recovery.test.ts`).

4. **Migrate `mount-table-store.ts` to descriptor-shaped rows.** Today (line 29-32) `MountEntry = { path, handle }` and `getAllMountEntries(): Promise<MountEntry[]>`. Required:
   - **Delete the old `MountEntry` export** to free the name (the new `backend.ts` directory-listing type is `MountDirEntry`, so there's no collision once the old one is removed — but the brief transition window during the PR will have both visible; importers must use the fully-qualified module path or be migrated in the same change).
   - New row shape `MountTableEntry = { targetPath, descriptor: BackendDescriptor, createdAt }`.
   - `getAllMountEntries(): Promise<MountTableEntry[]>` — returns descriptors, not raw handles. Local descriptors carry an `idbHandleKey` which the consumer uses to fetch the live `FileSystemDirectoryHandle` from IDB.
   - **Audit list — consumers of the previous return shape:**
     - `packages/webapp/src/ui/main.ts:1749` — passes the result straight into `recoverMounts(entries, sharedFs, log)`. `recoverMounts` itself becomes the descriptor-aware brancher.
     - `packages/webapp/src/fs/mount-recovery.ts` — current implementation iterates `{ path, handle }`; rewrites against `BackendDescriptor`. Specifically `MountRecoveryFS` (line 52, today: `mount(path, handle: FileSystemDirectoryHandle)`) widens its signature to `mount(path: string, backend: MountBackend)`.

5. **Add mount recovery to the extension boot path AND make the offscreen lick handler render `session-reload` correctly.** Today the recovery boot is CLI/Electron-only (`main.ts:1749`), and even if recovery were added to offscreen, the existing offscreen lick handler at `packages/chrome-extension/src/offscreen.ts:161-252` only special-cases `isUpgrade`. There's no `isSessionReload` branch and no call to `formatMountRecoveryPrompt`, so a `session-reload` event would render with `event.cronName` (undefined) and a `[Cron Event: undefined]\n\`\`\`json\n…\`\`\`` body — silently broken UX. Two changes are required, not one:

   **5a — Run recovery in the extension bootstrap.** Mirror `main.ts:1748-1763` into the offscreen bootstrap, **after** `Orchestrator.init()` resolves, `sharedFs` is available, **and `lickManager.setEventHandler(...)` has been registered with the formatter from 5b**. Order matters: a `session-reload` event emitted before the handler is wired (or before 5b lands the formatter) renders as the malformed `[Cron Event: undefined]` JSON block at `offscreen.ts:233-234`, defeating the purpose of running recovery here at all. Concretely: 5b first (formatter exists), then `setEventHandler(formatter-equipped handler)`, then this recovery block. Note: `routeLickToScoop` is a private helper inside `main()` (`main.ts:1503`) and is not visible to offscreen. Use the public emit API instead — `lickManager.emitEvent(event)` (defined at `packages/webapp/src/scoops/lick-manager.ts:105`). For local backend, `LocalMountBackend.fromHandle()` failing on permission triggers the existing handle-reactivation lick → panel approval card. For S3/DA, recovery succeeds without any UI gesture as long as profiles resolve and IMS hasn't expired.

   **5b — Extract a shared `formatLickEventForCone(event): { label, content } | null` helper.** Both `main.ts:1620-1650` and `offscreen.ts:161-252` build `eventLabel` + `content` for the cone-side rendering, but they currently diverge: `main.ts` knows `session-reload` + `mount-recovery` + `formatMountRecoveryPrompt`; `offscreen.ts` only knows `upgrade`. Move the shared logic into `packages/webapp/src/scoops/lick-formatting.ts` (or similar) and have both call sites import it. Without this step, the CLI cone shows actionable mount-recovery prompts while the extension cone shows a malformed JSON dump — divergent UX defeats the point of running recovery in offscreen at all.

6. **Add a raw-body bypass to `/api/fetch-proxy` in `packages/node-server/src/index.ts`.** Today (line ~960) the proxy uses `express.json({ limit: '50mb' })` mounted globally at `app.use(...)` (line 757) and re-serializes parsed bodies via `JSON.stringify(req.body)` before forwarding. This corrupts SigV4-signed S3 PUTs because:
   - The body bytes that were SHA-256-hashed and signed pre-flight no longer match the bytes sent on the wire.
   - `JSON.stringify` produces canonical output that may differ byte-for-byte from the original.

   Because `express.json()` is global middleware, a per-request bypass requires the JSON parser to **not consume the body before the proxy handler runs**. Two reasonable triggers:
   - **Header gate.** A `X-Slicc-Raw-Body: 1` request header. Implementation: gate the global `express.json()` with a `type` predicate (`type: (req) => req.get('X-Slicc-Raw-Body') !== '1' && req.is('application/json')`) so the parser skips itself when the header is set, leaving the raw stream available. The S3/DA backends always set the header.
   - **Content-type gate.** Restrict `express.json()` to `application/json` only (it already does this by default — but verify) and have S3/DA backends always send a non-JSON `Content-Type` (`application/octet-stream` etc.). Simpler, but more action-at-a-distance.

   Pick one at implementation time; the design's only constraint is "the JSON parser does not consume the body before the proxy handler runs."

These six prerequisites together unblock the backend code. Each is small and self-contained.

## Open risks

1. **R2 + AWS S3 coexistence requires multiple profiles.** v1 single-global-creds-per-profile means the user maintains separate named profiles (e.g. `s3.aws.*` and `s3.r2.*`) and passes `--profile` per mount. Per-mount credential override via flag is a v2 follow-up.
2. **DA single-IMS-identity.** v1 reuses the existing Adobe provider's IMS token. If the user is not authed for the Adobe LLM provider, DA mounts cannot authenticate. Mitigation: clear error message at mount time pointing to `oauth-token adobe` or the provider settings UI.
3. **DA API surface is external to this repo.** URLs like `https://admin.da.live/source/<org>/<repo>/<path>` and `GET /list/<org>/<repo>/<path>` are da.live's documented contract, not in-repo APIs. Implementer should link the spec to da.live's official API reference before coding the DA backend, and add the `da-list-response.json` test fixture from a real captured response. SigV4 by contrast is exercised against the official AWS SigV4 v4 test suite (vendored under `tests/.../fixtures/sigv4-vectors/`).
4. **Cross-peer BroadcastChannel cache divergence.** Panel and offscreen each maintain their own `RemoteMountCache` instance, both backed by the same IDB store but with independent in-memory state. Short divergences are absorbed by the TTL window; concurrent writes are governed by ETag conditionals. Worth a targeted test in `virtual-fs-mount-sync.test.ts` for the new message shape.

## Rollout

- Feature gate not required; new behavior is purely additive (new flags, new schemes).
- Existing local mounts continue to work unchanged because `mount` without `--source` still routes to the picker.
- Mount-table descriptors are upgraded transparently on first load (one-time migration in `mount-table-store.ts`):
  - Legacy rows (`{ path, handle }` shape, no `kind`/`mountId` fields) are detected and rewritten to `{ targetPath, descriptor: { kind: 'local', mountId: crypto.randomUUID(), idbHandleKey }, createdAt: Date.now() }`. The handle stays in IDB at `idbHandleKey`; only the table row shape changes.
  - The migration runs idempotently — re-running on already-upgraded rows is a no-op.
  - `mountId` is generated once per legacy row at upgrade time and persisted thereafter, so subsequent boots see the same id for the same mount. (To be clear: a fresh `mount` at the same target path always produces a new `mountId` — the persistence guarantee here is purely about preserving stable identity for the existing local mounts that survive the upgrade. Remote-mount cache namespacing is incidental, since legacy local rows have no remote cache to worry about.)
- Documentation updates ship in the same PR(s) — root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `docs/architecture.md`, README. Per the project's three-gate rule (tests, docs, verification), docs are part of the change.

## Out-of-scope follow-ups (v2+)

- Per-mount cred override flags (`--access-key-id` / `--secret-access-key` accepted as named flag values, never positional)
- AWS SSO / IAM Identity Center
- Pre-signed URL mounts
- Streaming reads/writes for large objects (chunked agent reads)
- Path-style addressing for MinIO / non-virtual-hosted endpoints (`--path-style` flag)
- DA multi-identity profiles
- Webhook-driven cache invalidation (S3 Events / DA push notifications)
