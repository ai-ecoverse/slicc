# Session Teleport: Cross-Browser Authentication Research

**Status**: Work in Progress  
**Date**: 2026-03-11

## Overview

Research into "teleporting" authenticated sessions between browser instances, enabling scenarios where:
- A user logs in interactively on their regular browser (with passkey/biometric support)
- The authenticated session is transferred to an automation browser (Chrome for Testing)
- The automation browser continues with full access, no re-authentication needed

## Use Case: Okta SSO

Corporate SSO flows (Okta, Azure AD, etc.) often require:
- Passkeys/biometrics (not available in automation browsers)
- MFA prompts (TOTP, push notifications)
- Human interaction for CAPTCHAs

This makes browser automation behind SSO challenging. Session teleport solves this by separating "human authenticates" from "robot works."

## Implementations

### 1. Single-Process (`okta-session-transfer.mjs`)

Simple proof of concept:
- Opens local Chrome (regular) for user login
- Waits for redirect away from Okta
- Captures cookies via Playwright's `context.storageState()`
- Opens remote Chrome for Testing with captured state
- Session transfers successfully

**Findings:**
- Playwright's `storageState` captures everything needed
- 21 cookies typical for Okta → Workday flow
- Session cookies + SAML assertions transfer cleanly

### 2. Auth Proxy (`okta-auth-proxy.mjs`)

Single script that monitors remote browser and spawns local browser on-demand:
- Remote browser navigates normally
- When Okta login form detected (DOM inspection), opens local Chrome
- User completes full auth flow (username → password → MFA)
- Session captured and applied to remote browser via `context.addCookies()`

**Challenges solved:**
- Login form detection: Check for `input[name="identifier"]` visibility
- MFA flow: Wait for URL to leave `okta.com`, not just form changes
- Race conditions: Synchronous lock before async auth work

### 3. Peer-to-Peer (`okta-p2p.mjs`)

Two separate processes communicating via HTTP:
- `node okta-p2p.mjs remote <url>` - Chrome for Testing, requests auth
- `node okta-p2p.mjs local` - Regular Chrome, handles login

Communication via localhost HTTP:
- Remote listens on port 3456, Local on 3457
- Remote POSTs auth request to Local
- Local POSTs session back to Remote

**Limitation:** Still requires host-level networking between processes.

### 4. WebRTC DataChannel (`okta-webrtc.mjs`)

True browser-to-browser communication:
- Each browser opens a "bridge page" with WebRTC code
- Browsers establish peer connection via DataChannel
- Auth requests and session data flow directly browser-to-browser
- Node scripts only exchange initial SDP offer/answer (signaling)

**Flow:**
```
Remote Browser                          Local Browser
     │                                       │
     │──── SDP Offer (via Node HTTP) ───────►│
     │◄─── SDP Answer (via Node HTTP) ───────│
     │                                       │
     │◄════ WebRTC DataChannel ═════════════►│
     │      (auth request)                   │
     │      (session cookies)                │
```

## WebRTC Technical Details

### SDP Token Size

For copy/paste signaling (no server), each side exchanges ~1KB base64:

```
=== OFFER TOKEN (1056 characters base64) ===
Contains:
- ICE candidates (public IP, local mDNS)
- ICE credentials (ufrag, pwd)
- DTLS fingerprint (SHA-256)
- SCTP config for DataChannel
```

### NAT Traversal

Current implementation uses Google's public STUN server:
```javascript
iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
```

- **STUN only**: Works ~80-85% of the time
- **Symmetric NATs**: Will fail without TURN
- **Corporate firewalls**: Often block UDP entirely

### TURN Server Considerations

True TURN requires:
- Raw UDP sockets
- Persistent relay ports
- Real-time packet forwarding

**Cannot run on Cloudflare Workers** (HTTP-only).

**Alternative: WebSocket Relay on Workers**

For session teleport (small data, not real-time media), a Durable Object relay works:

```javascript
export class RelayRoom {
  connections = new Set();
  
  async fetch(request) {
    const [client, server] = new WebSocketPair();
    this.connections.add(server);
    server.accept();
    
    server.addEventListener('message', (e) => {
      for (const conn of this.connections) {
        if (conn !== server) conn.send(e.data);
      }
    });
    
    return new Response(null, { status: 101, webSocket: client });
  }
}
```

Benefits:
- Works through any firewall (HTTPS/WSS)
- Handles signaling AND relay fallback
- Cloudflare Workers free tier sufficient

## Key Findings

1. **Session state is portable**: Cookies captured via Playwright transfer cleanly between browser instances.

2. **DOM detection beats URL detection**: Okta's SSO flow has intermediate redirects; checking for visible `input[name="identifier"]` is more reliable than URL patterns.

3. **MFA needs patience**: Must wait for full redirect chain to complete, not just form submission.

4. **WebRTC works for P2P**: DataChannel successfully transfers ~20KB of session data browser-to-browser.

5. **Signaling is the bottleneck**: WebRTC needs initial SDP exchange; true serverless requires copy/paste or QR codes.

## Files

All PoC files are in `src/poc/teleport/`:

| File | Description |
|------|-------------|
| `okta-session-transfer.mjs` | Simple single-process PoC |
| `okta-auth-proxy.mjs` | On-demand auth with monitoring |
| `okta-p2p.mjs` | Two-process HTTP communication |
| `okta-webrtc.mjs` | WebRTC browser-to-browser |
| `show-sdp.mjs` | Utility to display SDP token format |

## Next Steps

- [ ] Implement copy/paste signaling (no server dependency)
- [ ] Build Cloudflare Worker relay for firewall traversal
- [ ] Add QR code signaling option
- [ ] Generalize beyond Okta (Azure AD, Google Workspace)
- [ ] Session refresh/keepalive for long-running automation
