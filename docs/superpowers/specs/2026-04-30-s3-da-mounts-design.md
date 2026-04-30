# S3 and DA Mount Backends — Design

**Date:** 2026-04-30
**Status:** Draft (pending implementation plan)
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
- Dual-mode: works in CLI / Electron (via `/api/fetch-proxy`) and Chrome extension (direct fetch from offscreen)

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
| `backend.ts`           | `MountBackend` interface + shared types (`MountEntry`, `MountStat`, `RefreshReport`)                                           |
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

### Key types

```ts
// backend.ts
export type MountKind = 'local' | 's3' | 'da';

export interface MountEntry {
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

  readDir(path: string): Promise<MountEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;
  stat(path: string): Promise<MountStat>;
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  refresh(opts?: { bodies?: boolean }): Promise<RefreshReport>;
  describe(): { source?: string; profile?: string; extra?: string };
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
  entries: MountEntry[];
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
  putListing(dirPath: string, entries: MountEntry[]): Promise<void>;
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
export type BackendDescriptor =
  | { kind: 'local'; idbHandleKey: string }
  | { kind: 's3'; source: string; profile: string }
  | { kind: 'da'; source: string; profile: string };

export interface MountTableEntry {
  targetPath: string;
  descriptor: BackendDescriptor;
  createdAt: number;
}
```

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

```
on session start:
    descriptors = mountTableStore.getAll()
    for each desc in descriptors:
        try:
            switch desc.kind:
                'local' → handle  = loadFromIDB(desc.idbHandleKey)
                          backend = LocalMountBackend.fromHandle(handle)
                          // user-gesture lick for handle re-activation (existing flow)

                's3'    → profile = resolveS3Profile(desc.profile)   // missing → throw
                          cache   = new RemoteMountCache({ mountId: s3:<path>, ttlMs: 30_000 })
                          backend = new S3MountBackend({ source: desc.source, profile, cache })

                'da'    → profile = resolveDaProfile(desc.profile)   // expired → throw / re-auth
                          cache   = new RemoteMountCache({ mountId: da:<path>, ttlMs: 30_000 })
                          backend = new DaMountBackend({ source: desc.source, profile, cache })

            await VirtualFS.mount(desc.targetPath, backend)

        catch (err):
            log.warn(err)
            fireRecoveryLick({          // matches existing local-mount recovery lick pattern
                mountPath: desc.targetPath,
                kind: desc.kind,
                reason: err.message,
                retryHint: 'mount --source ' + desc.source +
                           (desc.profile ? ' --profile ' + desc.profile : '') + ' ' +
                           desc.targetPath,
            })
```

Recovery never auto-prompts the user mid-session. It surfaces an actionable lick and stays out of the way; cone shows it as a card with the retry command pre-filled.

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

| Cause                 | Message                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Bad URL               | `mount: invalid source 's3foo' — expected s3://bucket[/prefix]`                                     |
| Profile missing       | `mount: profile 's3.r2' not configured. Set s3.r2.access_key_id and s3.r2.secret_access_key first.` |
| Profile incomplete    | `mount: profile 's3.r2' missing required field 'secret_access_key'`                                 |
| Probe failed          | `mount: probe failed for s3://bucket — 403 Forbidden. Check creds for profile 'r2'.`                |
| Target not empty      | (existing message — unchanged)                                                                      |
| Scoop + local backend | `mount: cannot mount local directories from a scoop (no UI). Ask the cone.`                         |

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

Documented as a comment in the backend implementations.

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

- No silent 412 retry on writes — surface to agent
- No write batching / coalescing
- No background polling for staleness (TTL is read-driven)
- No offline mode with queued writes

## Dual-mode networking

| Float          | Strategy                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI / Electron | Signed request → `/api/fetch-proxy?url=...` → forwarded to S3/DA. Proxy must preserve `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256`, and the URL host (SigV4 signs all four). Mount-time probe is the early-warning. |
| Extension      | Direct `fetch()` from offscreen document. Manifest `host_permissions: <all_urls>` covers any S3 endpoint + da.live. Side panel never touches the network.                                                                    |

The fetch-proxy header preservation is a **known risk**; if probe fails on CLI with a `SignatureDoesNotMatch` body, mount fails fast with a message naming the proxy as the suspect. Section "Open risks" tracks this.

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
  virtual-fs-mount.test.ts       # VFS routing through MountBackend (adapted)
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

## Open risks

1. **`/api/fetch-proxy` header preservation for SigV4.** The proxy must pass through `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256`, and not modify the URL host. Mount-time probe is the early-warning. May require a small proxy adjustment as part of this work.
2. **R2 + AWS S3 coexistence.** v1 single-global-creds-per-profile means a user has to maintain separate profiles (e.g. `s3.aws.*` and `s3.r2.*`) and pass `--profile` per mount. Per-mount credential override via flag is v2 follow-up.
3. **DA single-IMS-identity.** v1 reuses the existing Adobe provider's IMS token. If the user is not authed for the Adobe LLM provider, DA mounts cannot authenticate. Mitigation: clear error message at mount time pointing to `oauth-token adobe` or the provider settings UI.

## Rollout

- Feature gate not required; new behavior is purely additive (new flags, new schemes).
- Existing local mounts continue to work unchanged because `mount` without `--source` still routes to the picker.
- Mount-table descriptors are upgraded transparently: existing local-mount entries are recognized by the absence of a `kind` field and migrated to `{ kind: 'local', ... }` on first load (one-time migration in `mount-table-store.ts`).
- Documentation updates ship in the same PR(s) — root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `docs/architecture.md`, README. Per the project's three-gate rule (tests, docs, verification), docs are part of the change.

## Out-of-scope follow-ups (v2+)

- Per-mount cred override flags (`--access-key-id` / `--secret-access-key` accepted as named flag values, never positional)
- AWS SSO / IAM Identity Center
- Pre-signed URL mounts
- Streaming reads/writes for large objects (chunked agent reads)
- Path-style addressing for MinIO / non-virtual-hosted endpoints (`--path-style` flag)
- DA multi-identity profiles
- Webhook-driven cache invalidation (S3 Events / DA push notifications)
