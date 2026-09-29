---
name: dns
description: |
  Use this when resolving DNS records or troubleshooting names and addresses
  with SLICC's built-in `dig` command. Covers record and reverse queries,
  supported DNS-over-HTTPS resolvers and fallback, output modes, version flags,
  and accepted `+opts`.
allowed-tools: bash
---

# dig

```bash
dig <name> [type] [@server] [+opts] [--json]
dig <type> <name> [@server] [+opts] [--json]
dig -x <address> [@server] [+opts] [--json]
dig -v | dig --version
```

Lone positional = name (type `A`). Types: `A` `AAAA` `MX` `TXT` `CNAME` `NS` `SOA` `SRV` `PTR` `CAA`.

Resolvers: Cloudflare default (`@1.1.1.1` `@1.0.0.1` `@cloudflare-dns.com`); Google (`@8.8.8.8` `@8.8.4.4` `@dns.google`); Quad9 (`@9.9.9.9` `@149.112.112.112` `@dns.quad9.net`). Other `@server` → Cloudflare + stderr note.

`-x` reverse PTR. `-v`/`--version` → `DiG 9.20.0-slicc (DNS-over-HTTPS)`. `+short` and `--json` mutually exclusive. Other `+opts` are no-ops.
