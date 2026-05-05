# Mounts

`mount` bridges remote storage into the VFS so the agent's file tools (`read_file`, `write_file`, `edit_file`, `bash`) work transparently against S3, S3-compatible services (Cloudflare R2, MinIO), and Adobe da.live — alongside the original local FS Access mounts.

## What you get

After mounting, the remote source looks like a regular directory:

```bash
mount --source s3://my-bucket/site --profile aws  /mnt/aws
mount --source da://my-org/my-repo               /mnt/da

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

## Setting up credentials

Credentials never reach the agent. Where they live depends on which deployment you run:

| Deployment                   | Storage                                    | Setup UX                                             |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `npx sliccy` / `slicc` (CLI) | `~/.slicc/secrets.env`                     | Edit the file in your text editor (no shell history) |
| Sliccstart (macOS native)    | macOS Keychain (service `ai.sliccy.slicc`) | Sliccstart Settings → Secrets (form UI)              |
| Chrome extension             | `chrome.storage.local`                     | Right-click extension icon → **Options** (form UI)   |

In all three, the credential channel is server-side / SW-side: the browser bundle never holds an `access_key_id`. The agent's `bash`, `node -e`, and `javascript` tools run in CSP-locked contexts (WASM / sandbox iframes) with no access to the storage backend.

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

You can also reach the page from the side-panel terminal:

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

DA mounts reuse the IMS bearer token from the existing Adobe LLM provider. If you've configured Adobe as your LLM provider, DA mounts work automatically. If not, the first mount fails with `EACCES` — log in via Settings → Providers → Adobe (or run `oauth-token adobe`) first.

## Mount syntax

```bash
mount [--source <url>] [--profile <name>] [--no-probe] [--max-body-mb <n>] <target-path>
mount unmount [--clear-cache] <target-path>
mount list
mount refresh [--bodies] <target-path>
```

Flags:

- `--source <url>` — `s3://bucket[/prefix]` or `da://org/repo[/path]`. Without it, falls back to the local FS-Access picker (cone only).
- `--profile <name>` — selects which `s3.<profile>.*` keys to use. Defaults to `default`. Accepted for symmetry on DA but DA has only one identity in v1.
- `--no-probe` — skip the mount-time `HEAD bucket` / `GET /list` probe. Use when you want the mount to land even if the source is temporarily unreachable; the first read or write surfaces any auth error instead.
- `--max-body-mb <n>` — override the per-mount body-size limit. Defaults: S3 25 MB, DA 5 MB.
- `--clear-cache` (on `unmount`) — drop the `RemoteMountCache` listings + bodies for that mount.
- `--bodies` (on `refresh`) — also conditionally re-fetch bodies whose ETag changed; without it, only listings are diffed.

## Common error patterns

| Error                                                                                    | What it means                                                           | Fix                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mount: probe failed for s3://… — profile 'aws' missing required field 'access_key_id'.` | The named profile isn't fully configured                                | Walk the user through `secret set s3.<profile>.*` (CLI) or open the Options page (extension) |
| `EACCES: s3 access denied`                                                               | Wrong credentials, wrong region for the bucket, or bucket policy denies | Verify with the AWS CLI: `aws s3 ls s3://<bucket>`                                           |
| `EACCES: da access denied`                                                               | IMS token expired or user not authed against the Adobe provider         | Re-auth Adobe in Settings → Providers                                                        |
| `EBUSY: remote modified since last read — re-read and retry`                             | Another writer changed the file between your read and your write        | Re-read with `read_file` then retry the edit                                                 |
| `EFBIG: body exceeds maxBodyBytes`                                                       | File is larger than the per-mount limit (S3 25 MB / DA 5 MB)            | Pass `--max-body-mb <n>` at mount time, or use AWS CLI / DA UI for very large files          |
| `mount: cannot mount local directories from a scoop (no UI).`                            | Local mounts need a user gesture                                        | Have the cone do the mount, or use S3/DA which work in scoops                                |

## Caching and conflict semantics

The `RemoteMountCache` (TTL + ETag, IDB-backed under `slicc-mount-cache`) sits in front of every read and listing. Default TTL is 30 s.

- **Reads**: cache-fresh → zero RTT; cache-stale → conditional `GET` with `If-None-Match` (304 keeps the cached body, 200 replaces it); cache-miss → unconditional `GET`.
- **Writes**: existing files use `If-Match: <etag>`; new files use `If-None-Match: *` to refuse silent overwrite. A 412 from a fresh first-attempt PUT surfaces as `FsError('EBUSY', …)` so the agent's edit loop can re-read and retry. (412 inside a bounded retry window of an in-flight PUT is silently reconciled — that case means "we already won this PUT" rather than a conflict.)
- **Mount-relative cache keys**: cached entries live under `(mountId, mountRelativePath)` so re-mounting at the same target path with a different source produces a fresh cache namespace; no aliasing.

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

See `docs/architecture.md` for the file map and `docs/superpowers/specs/2026-04-30-s3-da-mounts-design.md` for the full design rationale.

## Out of scope (v2)

- Server-side Adobe OAuth — DA's IMS token currently lives browser-side; v2 will move it
- Recursive `remove` on S3 (throws `EINVAL`; act on individual files for now)
- Per-mount credential override flags (only profile-based selection in v1)
- AWS SSO / IAM Identity Center
- Streaming reads/writes for objects beyond `maxBodyBytes`
- Webhook-driven cache invalidation (manual `mount refresh` only)
