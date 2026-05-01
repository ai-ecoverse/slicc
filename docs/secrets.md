# Secrets

SLICC can manage API keys, tokens, and credentials on your behalf — injecting them into HTTP requests without the agent ever seeing the real values. This prevents prompt-injection attacks from tricking the agent into exfiltrating your secrets.

## How it works

1. You store a secret (e.g. `GITHUB_TOKEN`) with a list of allowed domains (e.g. `api.github.com`).
2. The agent sees a **masked value** — a deterministic hash that looks like a real token but isn't. The mask changes every session.
3. When the agent makes an HTTP request through the fetch proxy, the server replaces the masked value with the real one — but **only if the destination domain is in the allowlist**.
4. Responses from upstream APIs are scrubbed: any real secret values echoed back are replaced with the masked value before the agent sees them.

The agent can use `$GITHUB_TOKEN` in shell commands and `curl` headers exactly as if it were real. It just never learns the actual value.

## Adding secrets

### Option 1: `.env` file (all platforms, node-server)

Create `~/.slicc/secrets.env`:

```env
GITHUB_TOKEN=ghp_abc123...
GITHUB_TOKEN_DOMAINS=api.github.com,*.github.com

OPENAI_KEY=sk-xyz...
OPENAI_KEY_DOMAINS=api.openai.com
```

Each secret needs two lines: `NAME=value` and `NAME_DOMAINS=domain1,domain2`. A secret without a `_DOMAINS` entry is rejected — every secret must be domain-scoped.

Set file permissions: `chmod 600 ~/.slicc/secrets.env`.

To use a different file path, pass `--env-file <path>` when starting SLICC, or set `SLICC_SECRETS_FILE` in your environment.

### Option 2: macOS Keychain (swift-server)

```bash
security add-generic-password \
  -s "ai.sliccy.slicc" \
  -a "GITHUB_TOKEN" \
  -w "ghp_abc123..." \
  -j "api.github.com,*.github.com" \
  -U
```

- `-s` — service name (always `ai.sliccy.slicc`)
- `-a` — secret name (becomes the env var name)
- `-w` — secret value
- `-j` — comma-separated domain allowlist (stored in the comment field)
- `-U` — update if the item already exists

The swift-server also supports `--env-file` for loading additional secrets from a `.env` file alongside Keychain secrets.

## The `secret` shell command

Inside the SLICC shell, the `secret` command manages secrets:

| Command                    | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `secret list`              | Show configured secrets (names and domains, never values)    |
| `secret set <name>`        | Show instructions for adding a secret via Keychain or `.env` |
| `secret delete <name>`     | Show instructions for removing a secret                      |
| `secret test <name> <url>` | Check whether a secret would be injected for a given URL     |

`secret test` is useful for verifying domain restrictions before making real requests:

```bash
$ secret test GITHUB_TOKEN https://api.github.com/repos/foo/bar
✅ GITHUB_TOKEN is allowed for api.github.com

$ secret test GITHUB_TOKEN https://evil.com/steal
❌ GITHUB_TOKEN is NOT allowed for evil.com
```

## Domain restrictions

Each secret has a list of glob patterns controlling where it can be injected:

| Pattern          | Matches                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `api.github.com` | Exact match only                                                        |
| `*.github.com`   | Any subdomain of `github.com` (e.g. `api.github.com`, `raw.github.com`) |
| `*`              | Any domain (use with caution)                                           |

A secret is only unmasked in a request if the target URL's hostname matches at least one pattern.

## Mount backend secrets

The `mount --source s3://...` and `mount --source da://...` shell commands resolve credentials from the same secret store. S3 uses a profile-namespaced convention; DA reuses the existing Adobe IMS token.

### S3 / S3-compatible (AWS, R2, MinIO, …)

Each S3 mount selects a profile via `--profile <name>` (defaults to `default`). The backend looks up these keys in the secret store:

| Key                              | Required | Notes                                                                                           |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `s3.<profile>.access_key_id`     | Yes      | AWS access key ID (or R2/MinIO equivalent).                                                     |
| `s3.<profile>.secret_access_key` | Yes      | Matching secret key.                                                                            |
| `s3.<profile>.region`            | No       | Defaults to `us-east-1`. R2 typically uses `auto`.                                              |
| `s3.<profile>.endpoint`          | No       | Custom endpoint host for S3-compatible services. Omit for AWS S3 (host is derived from region). |
| `s3.<profile>.session_token`     | No       | For STS temporary credentials.                                                                  |

Multiple profiles coexist — e.g. `s3.aws.*` for AWS plus `s3.r2.*` for Cloudflare R2 — and `--profile` selects between them per mount. Profiles are resolved at backend construction; on a 401/403 the backend re-resolves once (covers key rotation) before bubbling `EACCES`.

**Example: setting up an R2 profile via `~/.slicc/secrets.env`**

```env
s3.r2.access_key_id=R2_ACCESS_KEY_ID_HERE
s3.r2.access_key_id_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.secret_access_key=R2_SECRET_ACCESS_KEY_HERE
s3.r2.secret_access_key_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.endpoint=https://<account-id>.r2.cloudflarestorage.com
s3.r2.endpoint_DOMAINS=*.r2.cloudflarestorage.com
```

The mount backend reads the secret values directly (it doesn't go through the fetch-proxy domain check for the read itself), but every secret still needs a `_DOMAINS` entry — the runtime rejects unscoped secrets, and the same domain list is applied if any of these values ever appear in agent-visible output. Use the bucket's hostname pattern (`*.r2.cloudflarestorage.com` for R2, `*.amazonaws.com` for AWS) so the masked values can also flow through `bash` invocations like `aws s3 ...` if needed.

### Adobe da.live

DA mounts authenticate with the IMS bearer token from the existing Adobe provider. There is no DA-specific secret to set: if you've already configured Adobe as your LLM provider, `mount --source da://org/repo /mnt/da` will reuse that identity. The `--profile` flag is accepted for symmetry but multi-identity DA support is a v2 follow-up.

When IMS hasn't been authed (or the token has expired beyond what a refresh can recover), mount-time fails with an `EACCES` pointing at `oauth-token adobe` or the provider settings UI.

## How the fetch proxy works

All HTTP requests from the agent route through a server-side fetch proxy (`/api/fetch-proxy`). The proxy handles secrets in both directions:

**Outbound (request):**

- Scans request **headers** for masked values. If a masked value is found and the domain matches → unmask (replace with real value). If the domain doesn't match → **403 reject**.
- Scans request **body** for masked values. If the domain matches → unmask. If the domain doesn't match → **pass through unchanged** (the masked value is harmless, and blocking would break the agent's own LLM API calls which naturally contain masked values in conversation context).

**Inbound (response):**

- Scans response headers and body for real secret values and replaces them with masked equivalents before forwarding to the agent.

## Covered extraction vectors

The secrets system defends against multiple exfiltration paths:

| Vector                                      | Mitigation                                                   |
| ------------------------------------------- | ------------------------------------------------------------ |
| HTTP requests (`curl`, `fetch`)             | Fetch proxy with domain-scoped injection                     |
| Environment variables (`echo $TOKEN`)       | Shell env contains masked values, not real ones              |
| File reads (`cat ~/.env`)                   | Tool output scrubbed before reaching agent                   |
| Shell output (any command stdout/stderr)    | All bash tool output scrubbed                                |
| Git operations (`git diff`, `git log -p`)   | Output goes through bash scrubbing                           |
| Response echo-back (API returns your token) | Response body/headers scrubbed by fetch proxy                |
| Browser automation (CDP `evaluate`)         | Agent only has masked values; can't construct real requests  |
| Redirect URLs (secret in query params)      | Fetch proxy follows redirects server-side; URL never exposed |

## Extension mode

In Chrome extension mode, there is no server-side fetch proxy and no shell `secret` injection into request headers — that flow needs node-server or swift-server.

For **mount backends specifically** (`mount --source s3://...` and `mount --source da://...`), the extension is self-contained. Secrets live in `chrome.storage.local`, the service worker holds them, signs requests with SigV4 (S3) or attaches the IMS Bearer (DA), and forwards via `fetch()` (extension `host_permissions: <all_urls>` covers any S3/da.live host). The agent's tools (`bash` WASM, `node -e` and `javascript` in CSP-locked sandbox iframes) have no `chrome.*` API access, so they cannot read `chrome.storage` directly — the same isolation property that keeps `~/.slicc/secrets.env` out of the agent in CLI mode.

Set up extension-mode mount secrets via the `secret` shell command in the side-panel terminal:

```bash
secret set s3.r2.access_key_id   R2_ACCESS_KEY_ID   --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.secret_access_key R2_SECRET_KEY    --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.endpoint        https://<account>.r2.cloudflarestorage.com --domain "*.r2.cloudflarestorage.com"
```

Then `mount --source s3://my-bucket --profile r2 /mnt/r2` works the same as in CLI mode.

For **arbitrary HTTP secret injection** (e.g. `$GITHUB_TOKEN` in a `curl` call from `bash`), the extension still has no equivalent — that's the fetch-proxy injection, which requires a server backend.

## Platform support

| Runtime      | macOS                      | Windows                    | Linux                      |
| ------------ | -------------------------- | -------------------------- | -------------------------- |
| swift-server | ✅ Keychain + `.env`       | —                          | —                          |
| node-server  | ✅ `.env`                  | ✅ `.env`                  | ✅ `.env`                  |
| extension    | ⚠️ Requires server backend | ⚠️ Requires server backend | ⚠️ Requires server backend |
