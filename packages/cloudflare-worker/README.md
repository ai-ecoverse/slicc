# cloudflare-worker

Cloudflare Worker tray hub — session coordination, TURN credentials, WebRTC signaling

## Webapp Serving

The worker also serves the built SLICC webapp as static assets via Cloudflare Workers Static Assets. GET/HEAD requests without `?json=true` receive the SPA, while requests with `?json=true`, POST requests, and WebSocket upgrades get API/JSON responses.

Routes like `/join/:token` and `/controller/:token` serve the webapp for normal browser navigation (no `?json=true`), allowing the tray joining flow to be handled client-side. Programmatic callers append `?json=true` to get JSON.

Before deploying, build the webapp:

```bash
npm run build -w @slicc/webapp
```
