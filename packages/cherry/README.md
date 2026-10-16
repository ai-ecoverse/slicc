# @ai-ecoverse/cherry

Host-side SDK for embedding a [SLICC](https://github.com/ai-ecoverse/slicc)
follower in your web page. `mountSlicc()` creates the follower iframe, runs a
pinned `postMessage` handshake with it, and lends your page to a SLICC cone
(the leader) as a capability-limited browser target. The cone can read and
drive the page within the capabilities you grant. It never gets raw
`Network.*` access.

```bash
npm install @ai-ecoverse/cherry
```

```ts
import { mountSlicc } from '@ai-ecoverse/cherry';

const handle = mountSlicc({
  container: document.getElementById('slicc')!,
  sliccOrigin: 'https://www.sliccy.ai',
  joinToken, // tray join URL your backend provisioned for an existing cone
  capabilities: { navigate: false, screenshot: 'html2canvas', openUrl: true },
  hooks: {
    onSliccEvent: (name, detail) => console.log(name, detail),
  },
});

// later
handle.destroy();
```

The SLICC origin only allows framing (`frame-ancestors`) from host origins on
its allowlist, and the host page origin must differ from `sliccOrigin`.

## Entry points

| Import                                  | Contents                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@ai-ecoverse/cherry`                   | `mountSlicc` with the host-page CDP handler, option/handle types, `TranscriptExportError`         |
| `@ai-ecoverse/cherry/embed-ui`          | UI-only `mountSlicc` without the CDP handler, for embedders that only need the panel UI           |
| `@ai-ecoverse/cherry/protocol`          | The `postMessage` envelope contract (`CHERRY_PROTOCOL_VERSION`, `acceptEnvelope`, envelope types) |
| `@ai-ecoverse/cherry/preview-bridge.js` | Self-contained IIFE driveable-preview bootstrap (served by `serve --bridge` previews)             |

The SDK ships as ES modules with TypeScript declarations. Its only runtime
dependency is `html2canvas-pro`, which loads lazily and only when
`capabilities.screenshot` is `'html2canvas'`.

## Versioning

The package is released from the SLICC monorepo and carries the SLICC release
version. The follower and the SDK negotiate a wire protocol version during the
handshake, so a vendored SDK keeps working across SLICC releases until a
protocol version it speaks is retired.

Architecture and protocol details:
[`docs/cherry-details.md`](https://github.com/ai-ecoverse/slicc/blob/main/docs/cherry-details.md).

## License

Apache-2.0
