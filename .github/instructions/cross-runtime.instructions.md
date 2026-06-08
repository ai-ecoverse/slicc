---
applyTo: 'packages/node-server/**,packages/swift-server/**'
---

# Cross-runtime parity (node-server ↔ swift-server)

This change touches a server runtime. SLICC keeps `node-server` and `swift-server` at feature
parity for shared concerns — HTTP API endpoints, server-side request signing (S3 / DA mounts),
and mount handling. When you add or change one of these here, check whether the peer server
needs the matching change, or state explicitly in the PR why it is intentionally excluded.

The cloud / hosted-leader float reuses `node-server --hosted`, so node-server changes usually
carry into cloud automatically. See `docs/review-patterns.md` for the full five-runtime parity
matrix.
