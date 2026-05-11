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
GITHUB_TOKEN_DOMAINS=github.com,*.github.com,api.github.com,raw.githubusercontent.com

OPENAI_KEY=sk-xyz...
OPENAI_KEY_DOMAINS=api.openai.com
```

Each secret needs two lines: `NAME=value` and `NAME_DOMAINS=domain1,domain2`. A secret without a `_DOMAINS` entry is rejected — every secret must be domain-scoped.

**Note:** The bare `github.com` is required for `git push https://github.com/...` because `*.github.com` does not match the bare host (see `packages/shared/src/secret-masking.ts`).

### Shell-env naming convention

Only secrets whose names are valid POSIX env identifiers — `[A-Za-z_][A-Za-z0-9_]*` — are exposed as `$NAME` in the agent shell. Names containing dots, hyphens, or starting with a digit (e.g. `s3.r2.access_key_id`, `oauth.adobe.token`, `db.prod.password`) are still loaded into the fetch-proxy for header unmasking, but they do not leak into `printenv` or `$VAR` resolution. Use this to keep subsystem secrets (mount backends, OAuth replicas) out of the agent's environment while still letting the proxy substitute them when an HTTP request happens to carry the masked value.

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

Multiple profiles coexist — e.g. `s3.aws.*` for AWS plus `s3.r2.*` for Cloudflare R2 — and `--profile` selects between them per mount. Profiles are resolved server-side (CLI: by node-server's `EnvSecretStore`; extension: by the SW reading `chrome.storage.local`) on every signed request, so rotated credentials apply immediately on the next mount operation — no client-side cache to invalidate. A 401/403 from upstream surfaces directly as `EACCES`; the user can re-mount or update the profile and retry.

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

### Request-shape decision table

Different types of HTTP traffic route through different code paths:

| Request shape                              | Goes through                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read/write to /mnt/r2/foo.txt` (VFS API)  | mount backend → `s3-sign-and-forward` (CLI) or `mount.s3-sign-and-forward` (SW); SigV4-signed                                                                                                      |
| `mount --source da://...` ops              | mount backend → `da-sign-and-forward`; IMS bearer attached server/SW-side                                                                                                                          |
| `git push` / `git clone` over HTTPS        | isomorphic-git → `createProxiedFetch` → `/api/fetch-proxy` (CLI) or `fetch-proxy.fetch` (SW); Basic-auth unmask                                                                                    |
| `curl`, `wget`, `node fetch(...)`          | shell → `createProxiedFetch` → fetch proxy (CLI/SW); header-substring + Basic + URL-creds unmask                                                                                                   |
| `upskill <github-url>`                     | `createProxiedFetch` → fetch proxy; `Authorization: Bearer <masked>` unmasked at boundary                                                                                                          |
| LLM provider streaming (Anthropic, etc.)   | direct `fetch()` from page; routed via `llm-proxy-sw.ts` to `/api/fetch-proxy` (CLI) or extension `host_permissions` (CORS bypass; no secret injection — provider holds real key in webapp memory) |
| `aws s3 cp` from agent shell (raw S3 HTTP) | shell → `createProxiedFetch` → upstream. NOT signed. **Use `mount` instead.**                                                                                                                      |

### Migration note for file-PAT users

The file-on-disk PAT workaround (writing the real PAT to a file in the VFS so the agent could `cat` it) is no longer needed. Put PATs in `~/.slicc/secrets.env` (CLI) or the extension options page (extension); the agent sees only the masked value. The fetch proxy unmasks at the network boundary when the request domain matches the secret's allowlist.

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

### Threat model addendum

Shell commands implemented in kernel-realms (`.jsh` files, `node -e`, `python3 -c`) run in isolated contexts (DedicatedWorker threads or CSP-locked sandbox iframes) and do not have direct access to `localStorage` or the primary secret store. The masking defense relies on code-review discipline: new shell commands must not echo `localStorage` values directly to agent output. The masking layer assumes that the only path from real secrets to agent context is through tool output scrubbing and fetch-proxy unmask/scrub.

## OAuth tokens as secrets

Provider OAuth tokens (Google, Adobe, GitHub, etc.) obtained via `oauth-token <provider>` are now masked before being shown to the agent. The command returns a masked Bearer token in both CLI and extension modes. The real token is unmasked only at the network boundary (`/api/fetch-proxy` in CLI or the `fetch-proxy.fetch` SW Port handler in extension).

### Dual-storage model

OAuth tokens have a dual-storage architecture:

1. **Primary**: `localStorage.slicc_accounts` in the webapp (survives page reload)
2. **Replica**: In-memory store on the proxy side (node-server `OauthSecretStore`, swift-server `OAuthSecretStore`, or extension SW `chrome.storage.local`)

The webapp pushes masked entries to the replica on login/logout. The replica is used for unmasking at the network boundary. On extension/CLI initialization, the webapp re-pushes all OAuth entries to ensure the proxy has up-to-date replicas after a page reload.

### Reserved namespace

Secret names starting with `oauth.` are reserved for OAuth replicas (e.g., `oauth.google`, `oauth.adobe`). User-defined secrets with this prefix are rejected at load time.

### Known v1 limitation

In CLI mode, if a user opens SLICC in a new browser tab while node-server is already running (without restarting the server), the OAuth replicas remain empty until the next page reload. This means OAuth-bearing requests will fail with 403 until the page is reloaded. The extension is unaffected because `chrome.storage.local` persists across SW restarts.

### Provider credentials and `nuke`

Provider credentials (OAuth tokens, API keys stored in `slicc_accounts` localStorage) survive the `nuke` command by design. Explicit logout via the provider settings UI is the user-controlled erasure mechanism.

### OAuth approval gate

The OAuth login popup flow is the user-approval gate. Once a token is cached, subsequent `oauth-token <provider>` calls return the masked token immediately (no additional approval required, but the masked value is benign — the agent never sees the real token).

## Extension mode

In Chrome extension mode, agent-initiated HTTP requests now route through the `fetch-proxy.fetch` SW Port handler, providing full secret-injection coverage equivalent to CLI mode.

For **mount backends specifically** (`mount --source s3://...` and `mount --source da://...`), the extension is self-contained. Secrets live in `chrome.storage.local`, the service worker holds them, signs requests with SigV4 (S3) or attaches the IMS Bearer (DA), and forwards via `fetch()` (extension `host_permissions: <all_urls>` covers any S3/da.live host). The agent's tools (`bash` WASM, `node -e` and `javascript` in CSP-locked sandbox iframes) have no `chrome.*` API access, so they cannot read `chrome.storage` directly — the same isolation property that keeps `~/.slicc/secrets.env` out of the agent in CLI mode.

### Extension Options page (recommended)

Right-click the SLICC toolbar icon → **Options** (or `chrome://extensions` → SLICC → **Extension options**, or `secret edit` in the side-panel terminal). The page has a real form with a password input — paste from your password manager, no shell history involved.

The **S3 / R2 / MinIO profile** tab is a wizard: one form fills the five paired keys (`s3.<profile>.access_key_id`, `secret_access_key`, `region`, `endpoint`, `path_style`) with auto-derived domain wildcards from the endpoint host. The **Custom secret** tab handles arbitrary domain-scoped tokens.

### Shell command alternative

If you prefer the terminal:

```bash
secret set s3.r2.access_key_id   R2_ACCESS_KEY_ID   --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.secret_access_key R2_SECRET_KEY    --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.endpoint        https://<account>.r2.cloudflarestorage.com --domain "*.r2.cloudflarestorage.com"
```

Either way, `mount --source s3://my-bucket --profile r2 /mnt/r2` works the same as in CLI mode.

For **arbitrary HTTP secret injection** (e.g. `$GITHUB_TOKEN` in a `curl` call from `bash`), the extension still has no equivalent — that's the fetch-proxy injection, which requires a server backend.

### Where to look next

For the full mount setup guide (intent → backend mapping, lifecycle, error patterns, architecture), see [docs/mounts.md](mounts.md).

## Platform support

| Runtime      | macOS                                                    | Windows                                                  | Linux                                                    |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| swift-server | ✅ Keychain + `.env`                                     | —                                                        | —                                                        |
| node-server  | ✅ `.env`                                                | ✅ `.env`                                                | ✅ `.env`                                                |
| extension    | ✅ via SW fetch proxy (`fetch-proxy.fetch` Port handler) | ✅ via SW fetch proxy (`fetch-proxy.fetch` Port handler) | ✅ via SW fetch proxy (`fetch-proxy.fetch` Port handler) |
