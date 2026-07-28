# go-optel

Dependency-free Go client for Adobe's [`helix-rum-js`](https://github.com/adobe/helix-rum-js) wire format — the same Real User Monitoring (RUM) beacon protocol SLICC's webapp (`packages/webapp/src/ui/telemetry.ts`) and native Swift apps (`packages/swift-optel`) use. See [`docs/operational-telemetry.md`](../../docs/operational-telemetry.md) for the cross-float design.

> OpTel = Operational Telemetry — Adobe's RUM-style operational telemetry; not to be confused with OpenTelemetry (OTel).

## Why this is smaller than swift-optel

swift-optel instruments a UI: clicks, view navigation, Core Web Vitals. A headless CLI has none of that, so go-optel's intended surface is deliberately narrow — **two checkpoints only**:

- `Enter` — process launch.
- `Error` — a fatal/operational failure, always via `ReportError` (never a raw error string).

The `Checkpoint` type stays an open string (matching the other two implementations' wire format) so a future caller isn't blocked, but reaching for `Click`/`Navigate`/etc. in a CLI context is a smell.

## Usage

```go
import optel "github.com/ai-ecoverse/go-optel"

client := optel.Configure("slicc-cli", optel.Options{})
defer client.Flush(2 * time.Second) // bounded wait for in-flight beacons before exit

client.Sample(optel.Enter, "prompt", "") // source = subcommand name

if err != nil {
    client.ReportError("dial", err) // sanitized automatically
}
```

## Privacy / security note

Unlike a browser tab, a CLI's error strings routinely embed **credentials and PII** by construction:

- Go's `net/http` / `net/url` errors embed the full request URL — including any bearer token in its path or query — in their `Error()` string.
- OS-level file errors embed the user's home directory, which usually contains their login name.

`ReportError` always runs the message through `Sanitize`, which redacts every absolute URL down to `scheme://host/...` (dropping the path/query where a token would live) and collapses absolute POSIX/Windows paths to their first segment/drive letter, **before** truncating to 200 characters — redaction never happens after truncation, which could otherwise leave a partial (still-sensitive) fragment on the wire. Never call `client.Sample(optel.Error, source, err.Error())` directly; always go through `ReportError`.

## Sampling

One coin flip per `Configure` call (i.e. per process launch), not per event — matching how the webapp/swift-optel decide once per pageview/session, not per beacon. `OPTEL_RATE` (`on`/`off`/`high`/`low`; default weight 100) and `OPTEL_DEBUG` (wire-level logging) environment variables are honored uniformly, same names as swift-optel's `OptelEnvConfig`.

## Layout

| File            | Purpose                                                           |
| --------------- | ----------------------------------------------------------------- |
| `client.go`     | `Client` / `Configure` / `Sample` / `ReportError` / `Flush`       |
| `checkpoint.go` | `Checkpoint` wire-format enum                                     |
| `event.go`      | `Event` — the JSON beacon payload                                 |
| `session.go`    | 9-character session id generation                                 |
| `sampling.go`   | `SamplingConfig` (weight) + `Session` (once-per-process decision) |
| `transport.go`  | `HTTPTransport` — fire-and-forget POST, bounded by `Client.Flush` |
| `sanitize.go`   | URL/path redaction + truncation (see Privacy above)               |
| `referer.go`    | `referer` string construction (`https://{appID}{viewPath}`)       |
| `env.go`        | `OPTEL_RATE` / `OPTEL_DEBUG` resolution                           |

## Build and test

```bash
cd packages/go-optel
go test ./...
make check   # gofmt + tidy-check + go vet + golangci-lint + race tests + coverage floor
```
