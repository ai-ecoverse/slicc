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

In Chrome extension mode, there is no server-side fetch proxy. Secrets require a CLI or desktop backend (node-server or swift-server). When no backend is available, the agent is informed that secrets are unavailable.

## Platform support

| Runtime      | macOS                      | Windows                    | Linux                      |
| ------------ | -------------------------- | -------------------------- | -------------------------- |
| swift-server | ✅ Keychain + `.env`       | —                          | —                          |
| node-server  | ✅ `.env`                  | ✅ `.env`                  | ✅ `.env`                  |
| extension    | ⚠️ Requires server backend | ⚠️ Requires server backend | ⚠️ Requires server backend |
