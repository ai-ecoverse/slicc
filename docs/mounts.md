# Mounts

`mount` bridges remote storage into the VFS so the agent's file tools (`read_file`, `write_file`, `edit_file`, `bash`) work transparently against S3, S3-compatible services (Cloudflare R2, MinIO), and Adobe authoring content — alongside the original local FS Access mounts.

## What you get

After mounting, the remote source looks like a regular directory:

```bash
mount --source s3://my-bucket/site --profile aws  /mnt/aws
mount --source da://my-org/my-repo               /mnt/da    # Helix 5 da.live
mount --source aem://my-org/my-site              /mnt/aem   # Helix 6 Source Bus

ls /mnt/da                          # listing — first call hits network, then cached
read_file /mnt/da/index.html        # downloads + caches the body (TTL + ETag)
write_file /mnt/da/new.html "..."   # ETag-conditional PUT, surfaces conflicts
rm /mnt/da/old.html                 # DELETE
mount refresh /mnt/da               # re-walk the source, diff against cache
mount unmount /mnt/da
```

Reads cache for 30 s with ETag-conditional revalidation (zero RTT within TTL, 304-on-stale costs one round trip with no body bytes). Writes use `If-Match: <etag>` (or `If-None-Match: *` for new files) and surface concurrent-edit conflicts as `EBUSY`. Mount descriptors persist across browser/server restarts.

## Choosing a backend

| User intent                        | Backend                 | Source URI                                            |
| ---------------------------------- | ----------------------- | ----------------------------------------------------- |
| Local folder                       | Local                   | _no_ `--source` (interactive picker, cone only)       |
| AWS S3                             | S3                      | `s3://<bucket>[/<prefix>]`                            |
| Cloudflare R2                      | S3 with custom endpoint | `s3://<bucket>` + `endpoint` profile field            |
| MinIO / other S3-compatible        | S3 with custom endpoint | `s3://<bucket>` + `endpoint`, often `path_style=true` |
| Adobe Document Authoring (da.live) | DA                      | `da://<org>/<repo>[/<path>]`                          |
| AEM site on Helix 6                | AEM Source Bus          | `aem://<org>/<site>[/<path>]`                         |

### DA vs AEM: which store holds the content

A site upgraded to the Helix 6 architecture keeps its `da.live` authoring UI and its `<org>/<site>` identity, but its documents move out of `admin.da.live` and into the Source Bus at `https://api.aem.live/<org>/sites/<site>/source`. Mounting such a site through `admin.da.live` **succeeds** and indexes an unrelated project's boilerplate — the paths look plausible and the HTML parses, so neither a user nor an agent can tell from the mount output that it is the wrong repository (issue #2227).

So the URL scheme is not the decision:

- `aem://<org>/<site>` says "Source Bus" outright, and mounts it.
- `da://<org>/<repo>` **probes the site config first** — `GET https://api.aem.live/<org>/sites/<site>/config.json` — and looks at the host of `content.source.url`. `api.aem.live` means Helix 6, and the mount is re-routed to the Source Bus with a note on stderr. `content.da.live` (or anything else) stays on `admin.da.live`.
- If the config can't be read (no Adobe login, unknown site, transport failure), the mount **fails** rather than guessing. Silently mounting the wrong store is the outcome this rules out; writes against it would land somewhere real and invisible.
- `--backend da` / `--backend aem` forces the choice and skips the probe.

The two backends differ in what the API gives them:

|                  | DA (`admin.da.live`)                       | AEM Source Bus (`api.aem.live`)                                                                                       |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Listing          | `GET /list/<org>/<repo>/<dir>`             | `GET /<org>/sites/<site>/source/<dir>/` — the **trailing slash** is what makes it a listing; without it the path 404s |
| Listing metadata | name, ext, mtime                           | name, size, content type, mtime, explicit `application/folder` marker                                                 |
| Write            | `POST` multipart/form-data                 | `PUT` raw body + the document's `Content-Type`, 201 on create _and_ overwrite                                         |
| Delete           | `DELETE`, 404 when absent                  | `DELETE` → 204, 404 when absent                                                                                       |
| Versioning       | strong ETags, `If-Match` / `If-None-Match` | **no ETags and no conditional requests** — extra headers trip a CORS preflight the endpoint rejects                   |
| Empty folders    | listed                                     | do not exist; a folder 404s once its last file is gone                                                                |

Both authenticate with the same Adobe IMS bearer token and share the `da-sign-and-forward` transport; the envelope's `origin` field selects the upstream, and the allow-list in `executeDaSignAndForward` keeps that set closed to those two hosts.

## Setting up credentials

Credentials never reach the agent. Where they live depends on which deployment you run:

| Deployment                   | Storage                                    | Setup UX                                             |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `npx sliccy` / `slicc` (CLI) | `~/.slicc/secrets.env`                     | Edit the file in your text editor (no shell history) |
| Sliccstart (macOS native)    | macOS Keychain (service `ai.sliccy.slicc`) | Sliccstart Settings → Secrets (form UI)              |
| Chrome extension             | `chrome.storage.local`                     | Right-click extension icon → **Options** (form UI)   |

In all three, the credential channel is server-side / SW-side: the browser bundle never holds an `access_key_id`. The agent's `bash`, `node -e`, and `javascript` tools run in isolated contexts (just-bash / the kernel worker's DedicatedWorker JS realm) with no `chrome.*` API access and no access to the storage backend.

### CLI: edit `~/.slicc/secrets.env`

Each secret needs **two** entries: the value and a matching `_DOMAINS` line. Values in the file are parsed fresh on every signed request — no SLICC restart needed after edits.

```env
# AWS S3 (default profile)
s3.default.access_key_id=AKIA...
s3.default.access_key_id_DOMAINS=*.amazonaws.com
s3.default.secret_access_key=wJalr...
s3.default.secret_access_key_DOMAINS=*.amazonaws.com
s3.default.region=us-east-1
s3.default.region_DOMAINS=*.amazonaws.com

# Cloudflare R2 (named profile, custom endpoint)
s3.r2.access_key_id=...
s3.r2.access_key_id_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.secret_access_key=...
s3.r2.secret_access_key_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.endpoint=https://<account-id>.r2.cloudflarestorage.com
s3.r2.endpoint_DOMAINS=*.r2.cloudflarestorage.com
```

```bash
chmod 600 ~/.slicc/secrets.env
```

Inside the SLICC shell you can verify what's loaded:

```bash
secret list
```

### Extension: Options page

`chrome://extensions` → SLICC → **Extension options** (or right-click the toolbar icon → Options). Real form with password input — paste from your password manager, never type into a terminal. The page writes directly to `chrome.storage.local` using the same `<name>` + `<name>_DOMAINS` schema as CLI mode.

The **S3 / R2 / MinIO profile** tab is a wizard: one form fills the five paired keys (`s3.<profile>.access_key_id`, `secret_access_key`, `region`, `endpoint`, `path_style`) with auto-derived domain wildcards from the endpoint host.

You can also reach the page from the hosted leader tab's terminal:

```bash
secret edit
```

### Per-profile keys (S3)

| Key                              | Required | Notes                                                                             |
| -------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `s3.<profile>.access_key_id`     | yes      | AWS access key (or R2 / MinIO equivalent)                                         |
| `s3.<profile>.secret_access_key` | yes      | matching secret key                                                               |
| `s3.<profile>.region`            | no       | default `us-east-1`. R2 typically wants `auto`                                    |
| `s3.<profile>.endpoint`          | no       | custom host for R2 / MinIO. Omit for AWS                                          |
| `s3.<profile>.session_token`     | no       | for AWS STS temporary credentials                                                 |
| `s3.<profile>.path_style`        | no       | `"true"` for path-style addressing (some MinIO setups). Default is virtual-hosted |

Profiles coexist — `s3.aws.*`, `s3.r2.*`, `s3.minio-prod.*` all live in the same store, and `--profile` selects between them per mount.

### DA: no DA-specific secrets

DA mounts reuse the IMS bearer token from the existing Adobe LLM provider. If you've configured Adobe as your LLM provider, DA mounts work automatically. If not, the first mount fails with `EACCES` — log in via Settings → Providers → Adobe (or run `oauth-token adobe`) first. Note: `oauth-token adobe` now returns the **masked** Bearer token; mount backends consume the real IMS bearer via the existing mount-side handlers (`da-sign-and-forward` endpoints or SW `chrome.storage.local` in extension mode).

## Mount syntax

```bash
mount [--source <url>] [--profile <name>] [--backend <da|aem>] [--no-probe] [--max-body-mb <n>] <target-path>
mount unmount [--clear-cache] <target-path>
mount list
mount --list
mount refresh [--bodies] <target-path>
```

Flags:

- `--source <url>` — `s3://bucket[/prefix]`, `da://org/repo[/path]`, or `aem://org/site[/path]`. Without it, falls back to the local FS-Access picker (cone only — needs a user gesture; see [`docs/approvals.md` — Local mount picker](./approvals.md#local-mount-picker)).
- `--profile <name>` — selects which `s3.<profile>.*` keys to use. Defaults to `default`. Accepted for symmetry on DA but DA has only one identity in v1.
- `--backend <da|aem>` — force the Adobe backend instead of probing the site config. Use it when the probe is wrong, or when the config endpoint is unreachable but you know which store holds the content.
- `--no-probe` — skip the mount-time `HEAD bucket` / `GET /list` probe. It does **not** skip the `da://` content-source probe — that one decides _where_ to mount, not whether the source is reachable; `--backend` is the flag for that. Use when you want the mount to land even if the source is temporarily unreachable; the first read or write surfaces any auth error instead.
- `--max-body-mb <n>` — override the per-mount body-size limit. Defaults: S3 25 MB, DA/AEM 5 MB.
- `--clear-cache` (on `unmount`) — drop the `RemoteMountCache` listings + bodies for that mount.
- `--bodies` (on `refresh`) — also conditionally re-fetch bodies whose ETag changed; without it, only listings are diffed.

## Auto-mounted host folders: the mount table

A picker (`mount /mnt/foo`) mount dies on every full reload: Chrome drops the File System Access permission and the cone has to ask you to pick the folder again. For folders you _always_ want available, skip the picker entirely with the **mount table** — OS-folder → SLICC-path mappings owned by the launcher:

- **node-server**: repeatable `--mount=<os-path>:<slicc-path>` (e.g. `npx slicc --mount=~/Projects/foo:/mnt/foo --mount /data/docs:/mnt/docs`).
- **Sliccstart.app**: Settings → Mounts, one `os-path:slicc-path` mapping per line. Applies on the next browser launch.

The server serves each mapped folder over its local `/api/hostfs` bridge (loopback / bridge-token gated like every other `/api` route), and the webapp mounts them automatically at every kernel boot — no picker, no Chrome permission prompt, no user gesture. Properties:

- **Live view**: reads/writes go straight to the host filesystem, so external edits are visible immediately — no `mount refresh` needed (it's a no-op on these mounts).
- **Containment**: only paths under a mapped folder are reachable; `..` traversal and symlinks pointing outside the folder are refused, and the mount root itself cannot be removed.
- **Config-owned**: the table is the single source of truth. Entries are not persisted in the browser; edit the table and relaunch to change them. `mount unmount` removes one for the session only. A persisted picker/S3 row at the same target is not just skipped for the boot — it is **purged from the store**, so a later launch without the table entry can't silently fall back to a stale FS-Access handle and walk a tree you thought was config-owned.
- **Missing folders are skipped** at server start (with a warning) rather than failing the launch.
- **Webapp-initiated mounts are untouched**: `mount <path>` still opens the picker and still asks for permission on each reload — the table never widens what a picker grant allowed.
- Not available in the extension float or hosted/cloud mode: there is no local launcher to serve the folders.

`mount list` shows them with a `hostfs://<os-path>` source. The `:` split is on the last colon, so OS paths containing `:` work; `~` expands on the OS side.

### Wire shape (`/api/hostfs`)

Two request shapes reach the same handlers on both servers (node-server `src/hostfs.ts`, swift-server `HostFSRoutes.swift`):

| Request                                                                    | Ops                                         |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| `POST /api/hostfs` with a JSON body `{ op, mount, path, to?, recursive? }` | `list`, `stat`, `mkdir`, `rename`, `remove` |
| `GET /api/hostfs/read?mount=&path=` → octet-stream                         | `read`                                      |
| `PUT /api/hostfs/write?mount=&path=` ← octet-stream                        | `write`                                     |

The per-op routes (`GET /api/hostfs/list?mount=&path=` etc.) still work for every op; the webapp just prefers the stable one.

Why one URL: the bridge token rides as a custom `X-Bridge-Token` header, so every cross-origin hostfs call is a non-simple CORS request, and Chrome's Private Network Access preflights public→loopback traffic regardless. The preflight is unavoidable — but the browser's preflight cache is keyed by URL, and the per-op routes put the path in the query string, so `Access-Control-Max-Age` never got a cache hit: one benchmark session paid **246,893 `OPTIONS` for 385,033 `GET`s** ([#2715](https://github.com/ai-ecoverse/slicc/issues/2715)). Collapsing the metadata ops onto one URL makes that one preflight per max-age window, and `/api/hostfs*` preflights are served with Chrome's cap (`Access-Control-Max-Age: 7200`) instead of the 600 s the rest of `/api` uses.

`read` and `write` deliberately keep their per-file URLs: a `POST` response is not cacheable, and a read the browser can revalidate with a `304` is worth far more than its preflight — and those URLs repeat (the same packfile, the same `.git/index`), so the preflight cache does work for them.

The stable dispatcher owns its body end to end: it is excluded from node-server's global 50 MiB `express.json()` (`shouldParseGlobalJson`) so its own bounded 1 MiB parser applies, and body-parser failures are mapped to the same errno shape as every other error here — **400 `EINVAL`** for an unparseable body, **413 `EFBIG`** for an oversized one, identically on both bridges. Without that, express's default handler would answer malformed JSON with code-less HTML and the webapp could not rethrow a faithful `FsError`.

A bridge that predates the stable endpoint answers `POST /api/hostfs` with a framework 404 carrying no errno `code`; `HostFsMountBackend` treats exactly that as "no stable endpoint" and falls back to the per-op routes for the rest of the mount's life, at a cost of one wasted request. Every error the real route emits carries a `code`, so a genuine `ENOENT` never triggers the downgrade.

## Common error patterns

| Error                                                                                    | What it means                                                                                 | Fix                                                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `mount: probe failed for s3://… — profile 'aws' missing required field 'access_key_id'.` | The named profile isn't fully configured                                                      | Walk the user through `secret set s3.<profile>.*` (CLI) or open the Options page (extension)     |
| `EACCES: s3 access denied`                                                               | Wrong credentials, wrong region for the bucket, or bucket policy denies                       | Verify with the AWS CLI: `aws s3 ls s3://<bucket>`                                               |
| `EACCES: da access denied` / `EACCES: aem access denied`                                 | IMS token expired or user not authed against the Adobe provider                               | Re-auth Adobe in Settings → Providers                                                            |
| `mount: could not determine the content source for da://… `                              | The site config probe failed, so SLICC won't guess between `admin.da.live` and the Source Bus | Log in to the Adobe provider, check the org/site names, or pass `--backend da` / `--backend aem` |
| `EBUSY: remote modified since last read — re-read and retry`                             | Another writer changed the file between your read and your write                              | Re-read with `read_file` then retry the edit                                                     |
| `EFBIG: body exceeds maxBodyBytes`                                                       | File is larger than the per-mount limit (S3 25 MB / DA 5 MB)                                  | Pass `--max-body-mb <n>` at mount time, or use AWS CLI / DA UI for very large files              |
| `mount: cannot mount local directories from a scoop (no UI).`                            | Local mounts need a user gesture ([approvals](./approvals.md#local-mount-picker))             | Have the cone do the mount, or use S3/DA which work in scoops                                    |

## Caching and conflict semantics

The `RemoteMountCache` (TTL + ETag, IDB-backed under `slicc-mount-cache`) sits in front of every read and listing. Default TTL is 30 s.

- **Reads**: cache-fresh → zero RTT; cache-stale → conditional `GET` with `If-None-Match` (304 keeps the cached body, 200 replaces it); cache-miss → unconditional `GET`.
- **Writes**: existing files use `If-Match: <etag>`; new files use `If-None-Match: *` to refuse silent overwrite. A 412 from a fresh first-attempt PUT surfaces as `FsError('EBUSY', …)` so the agent's edit loop can re-read and retry. (412 inside a bounded retry window of an in-flight PUT is silently reconciled — that case means "we already won this PUT" rather than a conflict.)
- **AEM Source Bus, no ETags**: the Source Bus returns only `last-modified`, so the cache's `etag` slot holds a _surrogate_ — the modification time normalized to epoch-ms. Reads revalidate on TTL alone (no conditional GET). Writes cannot use `If-Match`, so a write against a file that was read first is preceded by a `HEAD`: a remote whose `last-modified` moved raises the same `EBUSY` the DA backend raises on a 412. A first write to a path SLICC has never read carries no guard, because there is no known version to lose an update against.
- **AEM listing sizes are the stored size**, not the decoded one. Cloudflare compresses these responses, so `content-length` (and the `size` in a listing) can be well under the bytes a `read_file` returns. `stat` reports the decoded size once the body is cached.
- **Mount-relative cache keys**: cached entries live under `(mountId, mountRelativePath)` so re-mounting at the same target path with a different source produces a fresh cache namespace; no aliasing.

## Index bounds and skip states

Each mount is indexed in the background so file discovery (`.jsh` / `.bsh` / skills) and listings are fast once ready. The walk is bounded so a pathologically deep, huge, or self-referential mount can't peg or OOM the kernel worker. When a bound is hit the index is **skipped** for that mount — reads still work through the slow per-`readDir` fallback, just without the fast index.

Defaults (raised 10× in #1186):

- Max directory depth: **400**
- Max total entries: **2,000,000**

Two environment variables override the defaults. Each must parse to a positive integer; a non-numeric, zero, negative, or `NaN` value is ignored — the default is used and a warning is logged.

| Variable                        | Overrides           | Default     |
| ------------------------------- | ------------------- | ----------- |
| `SLICC_MOUNT_INDEX_MAX_DEPTH`   | max directory depth | `400`       |
| `SLICC_MOUNT_INDEX_MAX_ENTRIES` | max total entries   | `2,000,000` |

(The worker / browser float has no OS env, so the defaults always apply there; the overrides are read once at construction in CLI / Electron mode.)

**Boot-time session restore uses a smaller budget** (`RESTORED_MOUNT_INDEX_LIMITS`: depth 100, 100,000 entries). The interactive defaults suit a folder the user just picked and is waiting on; at boot the same budget let a huge or cloud-backed tree (an iCloud folder full of dataless files) grind the kernel worker's I/O for minutes while the kernel-ready watchdog ran (2026-08-24 incident). A restored mount that hits the bound stays fully usable — only the fast-discovery index is truncated (`entries-exceeded`), and re-mounting interactively re-indexes with the full budget.

`mount list` renders a distinct, actionable line per skip cause:

| State              | `mount list` message                                        | Meaning / remedy                                                                                                |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `depth-exceeded`   | `index skipped: directory nesting exceeded the depth limit` | Legitimate but very deep tree. Raise `SLICC_MOUNT_INDEX_MAX_DEPTH`, or `mount unmount` it.                      |
| `entries-exceeded` | `index skipped: mounted tree is too large`                  | Legitimate but very large tree (explicitly **not** a cycle). Raise `SLICC_MOUNT_INDEX_MAX_ENTRIES`, or unmount. |
| `cycle-detected`   | `index skipped: self-referential mount cycle detected`      | A real, confirmed self-reference. Unmount it.                                                                   |
| `indexing-error`   | `index error: <message>`                                    | Any other indexing failure.                                                                                     |

A cycle is reported only when a cheap directory-fingerprint prefilter is confirmed by `FileSystemHandle.isSameEntry()` — a large or deep but legitimate mount is no longer mislabeled as "likely cyclic". Only `cycle-detected` means a true self-reference.

## Architecture

The browser bundle never computes signatures or holds credentials. Backends construct _logical_ requests (`{method, bucket, key, body, ...}` for S3; `{method, path, body, ...}` for DA) and hand them to an injected transport. The transport routes per deployment:

```
                ┌────────── browser bundle ──────────┐
                │ S3MountBackend                      │
                │ DaMountBackend                      │
                │ (signing-naive)                     │
                └────────────────┬────────────────────┘
                                 │ logical request
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
 CLI / Electron           Sliccstart (macOS)       Chrome extension
 POST /api/s3-...         POST /api/s3-...         chrome.runtime.sendMessage
        │                        │                        │
        ▼                        ▼                        ▼
 node-server              swift-server              service worker
 EnvSecretStore           Keychain SecretStore     chrome.storage.local
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 ▼
                     executeS3SignAndForward (shared)
                                 │
                                 ▼
                     signSigV4 → fetch → upstream
```

The Swift-server endpoint (`Sources/Server/SignAndForward.swift`) is a
behavior-parity port of the node-server handler — same envelope contract,
same hop-by-hop filter, same profile/key resolution rules — and reuses the
canonical AWS SigV4 test vectors, so byte-identical signatures are enforced
across all three runtimes.

For DA, the IMS bearer token transits the same envelope (browser-side state today; v2 will move OAuth server-side / SW-side).

See `docs/architecture.md` for the file map.

## Out of scope (v2)

- Server-side Adobe OAuth — DA's IMS token currently lives browser-side; v2 will move it
- Recursive `remove` on S3 (throws `EINVAL`; act on individual files for now)
- Per-mount credential override flags (only profile-based selection in v1)
- AWS SSO / IAM Identity Center
- Streaming reads/writes for objects beyond `maxBodyBytes`
- Webhook-driven cache invalidation (manual `mount refresh` only)
