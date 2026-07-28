# CLAUDE.md

This file covers the Go Operational Telemetry / RUM client in `packages/go-optel/`.

## Scope

`packages/go-optel/` is a dependency-free Go module (`github.com/ai-ecoverse/go-optel`, package `optel`) implementing Adobe's `helix-rum-js` beacon wire format for headless Go binaries. It is the Go analogue of `packages/swift-optel/` — same JSON shape, same `OPTEL_RATE`/`OPTEL_DEBUG` environment variables — but deliberately exposes a much smaller surface: no UI, so no `click`/`navigate`/CWV instrumentation. Consumed today by `packages/slicc-cli/` via a local `replace` directive (this is a monorepo without a Go workspace file; each Go module has its own `go.mod`).

## Build and Test Commands

```bash
cd packages/go-optel
go test ./...
make check   # gofmt + tidy-check + go vet + golangci-lint + race tests + coverage floor
```

No third-party dependencies — stdlib only (`net/http`, `math/rand/v2`, `regexp`, `crypto/rand`).

## Intended Surface: Launch + Error Only

Unlike swift-optel's `.optelAutoInstrument` (which wires four checkpoints — `enter`, `click`, `navigate`, `error`), go-optel's design intent is two checkpoints:

- `Enter` on process launch (`Client.Sample(optel.Enter, subcommand, "")`).
- `Error` on a fatal/operational failure, always via `Client.ReportError(source, err)` — never `Sample(Error, ...)` with a raw `err.Error()`.

The `Checkpoint` type is a plain string (not a closed enum) so the wire format matches the webapp/Swift implementations exactly, but reaching for `Click`/`Navigate`/`CWV` in a CLI context is a smell — there is no UI to click on.

## Privacy Is a Security Boundary Here, Not Just a Nicety

This library exists because a naive CLI telemetry hookup would leak
credentials, not just PII:

- **Go's `net/http` / `net/url` errors embed the full request URL** —
  including any bearer token in the path or query — in their `Error()`
  string. `slicc-cli` dials a leader's `https://…/join/<token>` URL; a raw
  dial-error string is a token leak.
- **OS-level file errors embed the user's home directory**, which on most
  platforms contains their login name.

`sanitize.go`'s `Sanitize(msg string) string` is the only sanctioned path
from an `error.Error()` string to a beacon field, and `Client.ReportError`
is the only sanctioned caller of it — never wire a raw error message into
`Sample` directly. Redaction order matters and is enforced in code, not just
by convention: URLs are reduced to `scheme://host/...` (the entire
path/query — where a token lives — is dropped, not partially truncated) and
absolute paths are collapsed to their first segment/drive letter, **before**
the 200-character truncation runs. Redacting after truncating would risk
leaving a partial (still-sensitive) fragment on the wire.

## Sampling Is Per-Process, Not Per-Event

`Configure` resolves exactly one sampling decision (`Session.Selected`) via
one coin flip, cached for the lifetime of the `*Client`. This mirrors how
the webapp/swift-optel decide once per pageview/session rather than per
beacon — a launch is the CLI's equivalent of a "pageview". Do not call
`Configure` more than once per process to try to get a fresh decision per
command; one `slicc` invocation is one launch.

## Flush Is Not Optional

Go has no `navigator.sendBeacon` guarantee that a fire-and-forget goroutine
outlives the calling function. `HTTPTransport.Send` posts on its own
goroutine and immediately returns so `Client.Sample`/`ReportError` never
block the CLI's user-facing streaming output — but the process **will**
exit and kill in-flight goroutines if nothing waits for them.
`Client.Flush(timeout)` blocks on an internal `sync.WaitGroup` bounded by
`timeout`; call it (deferred, with a short bound like 2s) once near process
exit. Skipping this makes every beacon a coin flip against process exit
timing.

## Related Guides

- `packages/swift-optel/CLAUDE.md` — the Swift analogue (iOS/macOS)
- `packages/slicc-cli/CLAUDE.md` — the only current consumer
- `docs/operational-telemetry.md` — cross-float RUM design and checkpoint mapping
