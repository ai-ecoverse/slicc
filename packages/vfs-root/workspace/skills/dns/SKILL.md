---
name: dns
description: |
  Use this when resolving DNS records or troubleshooting names and addresses
  with SLICC's built-in `dig` command. Covers record and reverse queries,
  supported DNS-over-HTTPS resolvers and fallback, output modes, version flags,
  and accepted `+opts`.
allowed-tools: bash
---

# DNS lookups with dig

SLICC's built-in `dig` resolves DNS records over DNS-over-HTTPS (DoH):

```bash
dig <name> [type] [@server] [+opts] [--json]
dig <type> <name> [@server] [+opts] [--json]
dig -x <address> [@server] [+opts] [--json]
dig -v | dig --version
```

The name and supported record type may appear in either order. A lone positional
is always the name and defaults to type `A`. Supported types are `A`, `AAAA`,
`MX`, `TXT`, `CNAME`, `NS`, `SOA`, `SRV`, `PTR`, and `CAA`.

## Resolver selection

| Resolver   | Supported `@server` values                       |
| ---------- | ------------------------------------------------ |
| Cloudflare | `@1.1.1.1`, `@1.0.0.1`, `@cloudflare-dns.com`    |
| Google     | `@8.8.8.8`, `@8.8.4.4`, `@dns.google`            |
| Quad9      | `@9.9.9.9`, `@149.112.112.112`, `@dns.quad9.net` |

Cloudflare is the default. Any other `@server` falls back to Cloudflare and
prints a note on stderr because arbitrary DNS servers cannot be queried over
the built-in DoH transport.

## Flags and output

- `-x <address>` performs an IPv4 or IPv6 reverse lookup as a `PTR` query.
- `-v` and `--version` print `DiG 9.20.0-slicc (DNS-over-HTTPS)` and exit.
- `+short` prints one answer value per line; `--json` prints raw resolver JSON.
  They are mutually exclusive.
- Other `+opts`, such as `+noall` and `+answer`, are accepted as no-ops.
