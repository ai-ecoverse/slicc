---
name: mount
description: |
  Use this whenever the user asks to mount anything — local folders, S3
  buckets, S3-compatible services (Cloudflare R2, MinIO), or Adobe da.live
  / AEM Document Authoring repos. Read this skill BEFORE deciding which
  backend to use; do NOT default to a local file picker when the user
  names a remote service. Covers credential setup with profile-namespaced
  `secret set` keys (e.g. `s3.aws.access_key_id`) or the extension Options
  page, the right `mount --source` invocation per intent, `mount info` for
  probed case/Unicode/exec-bit semantics, and common errors (EACCES on
  missing credentials, EBUSY on concurrent edits, EFBIG on oversized files).
allowed-tools: bash, read_file, write_file, edit
---

# Mount

`mount` bridges remote storage into the VFS. After mounting, `read_file`, `write_file`, `edit`, and `bash` work against the remote source.

| Backend | Source URI                    | Auth                                          |
| ------- | ----------------------------- | --------------------------------------------- |
| Local   | (no `--source`)               | OS file picker — cone-only, fails in scoops   |
| Host    | (launcher mount table)        | Already mounted — do not picker-mount over it |
| S3      | `s3://<bucket>[/<prefix>]`    | Profile secrets (`s3.<profile>.*`)            |
| DA      | `da://<org>/<repo>[/<path>]`  | Adobe IMS bearer (Adobe LLM provider login)   |
| AEM     | `aem://<org>/<site>[/<path>]` | Adobe IMS bearer (same login)                 |

Launcher mounts (`--mount` / Sliccstart Settings → Mounts) appear in `mount list` as `hostfs://<os-path>`. Do not `mount <that-path>` over them.

## Choosing a backend

| User says                           | Backend                                            |
| ----------------------------------- | -------------------------------------------------- |
| "mount my Documents" / "mount /tmp" | Local — `mount /mnt/documents`                     |
| `s3://…`                            | S3 — `mount --source s3://… /mnt/s3`               |
| "mount this R2 bucket"              | S3 + custom-endpoint profile                       |
| "mount da.live" / "mount Adobe DA"  | DA — `mount --source da://<org>/<repo> /mnt/da`    |
| "mount Helix 6" / "Source Bus"      | AEM — `mount --source aem://<org>/<site> /mnt/aem` |
| MinIO etc.                          | S3 + custom-endpoint profile                       |

If the URL is `s3://`, `da://`, or `aem://`, don't ask. If ambiguous, ask one specific question — don't offer a menu. **Don't default to local when the user names a remote service.**

### DA vs AEM

`da://` probes site config and re-routes to Source Bus on Helix 6 (note on stderr). `mount --source da://<org>/<site>` is always safe.

- Read stderr: `mount: <org>/<site> is on Helix 6 …` means landed on `aem://` — correct.
- `could not determine the content source` → usually no Adobe login. Fix login or pass `--backend da` / `--backend aem`. Don't retry blindly.

## Credentials

### S3 / R2 / MinIO

```bash
secret set s3.default.access_key_id      AKIA...      --domain "*.amazonaws.com"
secret set s3.default.secret_access_key  ...          --domain "*.amazonaws.com"
secret set s3.default.region             us-east-1    --domain "*.amazonaws.com"

secret set s3.r2.access_key_id           ...          --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.secret_access_key       ...          --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.endpoint                https://<account>.r2.cloudflarestorage.com  --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.path_style              true         --domain "*.r2.cloudflarestorage.com"  # if "Bucket name was not in expected format"
```

Required: `access_key_id`, `secret_access_key`. Optional: `region` (default `us-east-1`), `endpoint`, `session_token`, `path_style` (`"true"`).

CLI/Electron: `~/.slicc/secrets.env` or macOS Keychain. Extension: `chrome.storage.local`.

### Adobe DA / AEM

Uses Adobe IMS bearer from the Adobe LLM provider — no DA-specific secrets. First mount fails with `EACCES` if not logged in → Settings → Providers → Adobe or `oauth-token adobe`.

## Mounting

```bash
mount /mnt/local                                          # local picker (cone only)
mount --source s3://my-bucket           /mnt/s3
mount --source s3://my-bucket/site      --profile aws  /mnt/aws
mount --source s3://my-r2-bucket/path   --profile r2   /mnt/r2
mount --source da://my-org/my-repo      /mnt/da
mount --source aem://my-org/my-site     /mnt/aem
```

| Flag                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `--profile <name>`    | S3 profile (default `default`)                                        |
| `--backend <da\|aem>` | Force Adobe backend (skip probe)                                      |
| `--no-probe`          | Skip mount-time HEAD/GET probe (not the `da://` content-source probe) |
| `--max-body-mb <n>`   | Body limit (default S3 25 MB, DA/AEM 5 MB)                            |

## Lifecycle

```bash
mount list                         # active mounts
mount --list / mount -l            # same
mount info /tmp                    # probe case/Unicode/exec-bit
mount info --json /mnt/kb          # JSON report
mount unmount /mnt/r2              # tear down (cache kept within TTL)
umount /mnt/r2                     # alias (same flags/exit codes)
mount unmount --clear-cache /mnt/r2
mount refresh /mnt/r2              # re-walk + diff
mount refresh --bodies /mnt/r2     # also re-fetch changed bodies
```

`umount` is a plain alias. Unmounting an unmounted path is a no-op.

### `mount info`

Two mounts can disagree on identity. MEASURED: `/tmp` is case-sensitive, byte-exact; macOS APFS hostfs is case- and Unicode-normalization-insensitive. **Don't discover by renaming** — case/Unicode renames on insensitive volumes truncate files (#3107).

```bash
mount info --json /mnt/kb
```

Fields: `caseSensitivity`, `unicodeNormalization` (`byte-exact` vs `insensitive`), `unicodeStorage` (`nfc`/`nfd`/`as-written`), `executableBit`, `namesRoundTripByteExact`, `maxFilenameLength`, `writable`, `hostBacked`. If insensitive, fold case + NFC — don't rename spellings.

Built-in paths like `/tmp` support `chmod` executable bits; mounted sources report what their bridge implements.

`mount refresh` prints `Refreshed /mnt/r2: +2 -1 ~3 (47 unchanged, 0 errors)`. On hostfs, non-zero `unchanged` confirms the walk ran.

## Index bounds (`mount list`)

Background index for fast discovery. Defaults (10× raised): depth **400**, entries **2,000,000**. Override: `SLICC_MOUNT_INDEX_MAX_DEPTH`, `SLICC_MOUNT_INDEX_MAX_ENTRIES`.

| `mount list` cause                           | Remedy                                     |
| -------------------------------------------- | ------------------------------------------ |
| `directory nesting exceeded the depth limit` | Raise depth env or unmount                 |
| `mounted tree is too large`                  | Raise entries env or unmount (not a cycle) |
| `self-referential mount cycle detected`      | Real cycle — unmount                       |
| `index error: <message>`                     | Other failure                              |

Only `self-referential mount cycle detected` means a true cycle.

## Reading and writing

```bash
ls /mnt/da
read_file /mnt/da/index.html
write_file /mnt/da/new-page.html "<html>..."
edit /mnt/da/index.html
rm /mnt/da/old.html
```

TTL + ETag caching (30 s). Writes use `If-Match` / `If-None-Match: *`.

**AEM**: no ETags — conflict detection uses `last-modified` and only covers files you read first. Blind `write_file` overwrites. Read before write on `aem://`.

## Common errors

| Error                                                   | Meaning                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `probe failed … missing required field 'access_key_id'` | Set `secret set s3.<profile>.*`                                     |
| `EACCES: s3 access denied`                              | Wrong creds/region/policy                                           |
| `EACCES: da/aem access denied`                          | IMS token expired / not authed                                      |
| `could not determine the content source for da://…`     | No Adobe login, or use `--backend`                                  |
| `EBUSY: remote modified since last read`                | Re-read and retry                                                   |
| `EFBIG: body exceeds maxBodyBytes`                      | Over limit — `aws s3 cp` or `--max-body-mb`                         |
| `cannot mount local directories from a scoop`           | Ask cone to mount, or use S3/DA                                     |
| `EINVAL: symlinks not supported on mounted filesystems` | Link _on_ mount refused — put link on VFS: `ln -s /mnt/… /shared/x` |

## Exploring mounted sources

Prefer `bash: ls` over `read_file` for navigation (cached within TTL). `read_file` only files you need.

- **DA**: `/list` has no sizes — first `ls -l` does one HEAD per file, then caches 30 s.
- **AEM**: listings carry size/mtime — one listing, no per-file round-trips. Size is stored (compressed) until read. Empty folders don't exist.

## Don't

- Don't suggest separate AWS CLI / da.live SDK — `mount` is the integration.
- Don't `cd` into a remote mount before mounting.
- Don't ask "do you have credentials" — try mount, surface the error.
- Don't use `--no-probe` for `could not determine the content source` — it doesn't skip that probe.
- Don't fall back to local when user named a remote service.
- Don't rename for case/Unicode until `mount info` says byte-exact (#3107).
- Don't create a symlink _on_ a mount (`ln -s x /mnt/kb/link` → `EINVAL`). VFS→mount is fine (`ln -s /mnt/kb /shared/kb`).
- Don't `mount` over existing `hostfs://` entries.
