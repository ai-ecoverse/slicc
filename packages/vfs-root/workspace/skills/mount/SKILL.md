---
name: mount
description: Mount local folders, S3 / S3-compatible buckets (AWS, Cloudflare R2, MinIO), and Adobe da.live repos into the VFS so file tools work against remote storage transparently
allowed-tools: bash, read_file, write_file, edit_file
---

# Mount

The `mount` shell command bridges remote storage into the VFS. After mounting, `read_file`, `write_file`, `edit_file`, and `bash` (with `cat`, `ls`, etc.) all work against the remote source as if it were a local directory. Three backends:

| Backend | Source URI                   | Auth                                                   |
| ------- | ---------------------------- | ------------------------------------------------------ |
| Local   | (no `--source`)              | OS file picker — cone-only, fails in scoops            |
| S3      | `s3://<bucket>[/<prefix>]`   | Profile-namespaced secrets (`s3.<profile>.*`)          |
| DA      | `da://<org>/<repo>[/<path>]` | Adobe IMS bearer (reuses the Adobe LLM provider login) |

## Choosing a backend from user intent

When the user asks to "mount X", read the request literally before defaulting to local:

| User says                                        | Use this backend                                        |
| ------------------------------------------------ | ------------------------------------------------------- |
| "mount my Documents folder" / "mount /tmp"       | Local — `mount /mnt/documents`                          |
| "mount this S3 bucket: s3://my-bucket/foo"       | S3 — `mount --source s3://my-bucket/foo /mnt/s3`        |
| "mount this R2 bucket"                           | S3 with a custom-endpoint profile (R2 is S3-compatible) |
| "mount the AEM DA repo for org/site"             | DA — `mount --source da://<org>/<site> /mnt/da`         |
| "mount this Adobe DA project" / "mount da.live"  | DA                                                      |
| "mount this S3-compatible storage" (MinIO, etc.) | S3 with a custom-endpoint profile                       |

If the URL scheme is `s3://` or `da://`, the choice is unambiguous — don't ask. If the user gives a hostname or describes a service without a URL, ask one specific clarifying question (e.g. "Is this the AEM Document Authoring service at da.live, or a different system?") rather than offering a menu of generic options.

**Don't default to local when the user mentions a remote service name.**

## Setting up credentials before the first mount

### S3 / R2 / MinIO

S3 mounts read credentials from profile-namespaced secrets. Set them via the `secret` command before mounting. The agent never sees real secret values; only the server-side sign-and-forward handler does.

```bash
# AWS S3 (default profile)
secret set s3.default.access_key_id      AKIA...      --domain "*.amazonaws.com"
secret set s3.default.secret_access_key  ...          --domain "*.amazonaws.com"
secret set s3.default.region             us-east-1    --domain "*.amazonaws.com"

# Cloudflare R2 (uses a custom endpoint, requires path-style addressing for some setups)
secret set s3.r2.access_key_id           ...          --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.secret_access_key       ...          --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.endpoint                https://<account>.r2.cloudflarestorage.com  --domain "*.r2.cloudflarestorage.com"
# Optional — only set this if R2 returns "Bucket name was not in expected format" at first read:
secret set s3.r2.path_style              true         --domain "*.r2.cloudflarestorage.com"
```

Per-profile keys: `access_key_id` and `secret_access_key` are required; `region` (default `us-east-1`), `endpoint` (custom host for R2/MinIO), `session_token` (for STS), and `path_style` (`"true"` for path-style addressing) are optional.

In **CLI / Electron mode** secrets live in `~/.slicc/secrets.env` (or macOS Keychain via swift-server). In **extension mode** they live in `chrome.storage.local` and the `secret` command writes to it directly.

### Adobe da.live

DA mounts use the Adobe IMS bearer token from the existing Adobe LLM provider — there are no DA-specific secrets to set. **If the user has not logged into the Adobe LLM provider yet, the first mount will fail with `EACCES`. Tell them to log in via Settings → Providers → Adobe (or run `oauth-token adobe`) first.**

## Mounting

```bash
# Local (interactive picker, cone only)
mount /mnt/local

# S3 — bucket + optional prefix
mount --source s3://my-bucket           /mnt/s3
mount --source s3://my-bucket/site      --profile aws  /mnt/aws

# Cloudflare R2 — same s3:// scheme, different profile (custom endpoint)
mount --source s3://my-r2-bucket/path   --profile r2   /mnt/r2

# Adobe da.live — org + repo
mount --source da://my-org/my-repo      /mnt/da
```

Useful flags:

- `--profile <name>` — selects which `s3.<profile>.*` keys to use (S3 only). Defaults to `default`.
- `--no-probe` — skip the mount-time `HEAD bucket` / `GET /list` probe. Use when you want the mount to land even if the source is temporarily unreachable; first read/write will surface any auth errors instead.
- `--max-body-mb <n>` — override the per-mount body-size limit. Defaults: S3 25 MB, DA 5 MB. Files exceeding this throw `EFBIG` before bytes flow.

## Lifecycle

```bash
mount list                         # show all active mounts
mount unmount /mnt/r2              # tear down (cache stays for next mount within TTL)
mount unmount --clear-cache /mnt/r2 # tear down + drop cached listings/bodies
mount refresh /mnt/r2              # re-walk the source and diff against cache
mount refresh --bodies /mnt/r2     # also conditionally re-fetch changed bodies
```

`mount refresh` prints a structured summary: `Refreshed /mnt/r2: +2 -1 ~3 (47 unchanged, 0 errors)`. Use it after you know the remote changed externally and you want the local view to catch up before the 30 s TTL expires.

## Reading and writing once mounted

Treat the mount path like any other VFS directory:

```bash
ls /mnt/da
read_file /mnt/da/index.html
write_file /mnt/da/new-page.html "<html>..."
edit_file /mnt/da/index.html       # via the standard edit_file tool
rm /mnt/da/old.html
```

Reads and writes use TTL + ETag caching (30 s default). Reads are zero-RTT within TTL. Writes use `If-Match` / `If-None-Match: *` for conflict detection.

## Common error patterns

| Error                                                                                    | What it means                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount: probe failed for s3://… — profile 'aws' missing required field 'access_key_id'.` | The user hasn't set credentials yet. Walk them through `secret set s3.<profile>.*`.                                                                               |
| `EACCES: s3 access denied`                                                               | Wrong credentials, wrong region, or the bucket policy denies the user.                                                                                            |
| `EACCES: da access denied`                                                               | IMS token expired or user not authed against the Adobe provider.                                                                                                  |
| `EBUSY: remote modified since last read — re-read and retry`                             | Concurrent writer changed the file. Re-read with `read_file` and retry the edit.                                                                                  |
| `EFBIG: body exceeds maxBodyBytes`                                                       | File is over the per-mount size limit (S3 25 MB, DA 5 MB). Use shell tools (`aws s3 cp`) for very large files instead, or pass `--max-body-mb <n>` at mount time. |
| `mount: cannot mount local directories from a scoop (no UI).`                            | Local mounts need a user gesture. Either ask the cone to mount, or use S3/DA which work in scoops.                                                                |

## When asked to "explore" a mounted DA or S3 source

After mounting, prefer `bash: ls` over `read_file` for navigation — it's instant within the TTL window because the listing is cached. Only `read_file` files you actually intend to read; every read is a network round-trip on the first call.

For DA specifically: the `/list` endpoint doesn't include file sizes, so `ls -l` triggers one HEAD per file the first time, then caches. Subsequent `ls -l` within 30 s is free.

## Don't

- Don't suggest the user install a separate AWS CLI / da.live SDK — `mount` is the integration point.
- Don't try to `cd` into a remote mount before mounting; `bash`'s working directory is independent of mount setup.
- Don't ask "do you have credentials" if the user has already named a service — try the mount first, surface the actionable error from the probe, and walk them through the specific `secret set` commands.
- Don't fall back to a local mount if the user mentioned a remote service. Default to clarifying which remote backend, not which directory to pick.
