import Foundation
import HTTPTypes

/// Bridge security primitives for the standalone thin `/cdp` bridge.
///
/// Mirrors `packages/node-server/src/bridge-security.ts` byte-for-byte (the
/// same way `SigV4Signer` mirrors the JS signer). The standalone swift-server
/// proxies CDP from a sliccy.ai-hosted leader tab to the local Chrome over
/// `/cdp`. Full CDP pass-through = full control of the user's Chrome, so the
/// WebSocket upgrade is gated by two factors plus PNA:
///   1. Origin allowlist (`isAllowedBridgeOrigin`).
///   2. Per-process subprotocol token in `Sec-WebSocket-Protocol`
///      (`bridgeSubprotocolPrefix` + token). Never appears in a query string
///      so it does not leak into Referer / logs.
///   3. PNA preflight (`buildPnaPreflightHeaders`) — Chrome blocks
///      public→private WS upgrades without `Access-Control-Allow-Private-Network`.
///
/// Cross-origin `/api` calls from the hosted leader also need CORS; see
/// `buildBridgeCorsHeaders` for the per-request response set.
enum BridgeSecurity {
    /// Origin allowlist. Production + staging worker plus the dev-mode loopback
    /// origins (parallel to chrome-extension's `BRIDGE_DEV_ORIGINS`). Add a new
    /// origin here and in the extension allowlist together — they MUST stay in
    /// sync, otherwise extension and standalone disagree on what's a leader.
    static let allowedOrigins: [String] = [
        "https://www.sliccy.ai",
        "https://slicc-tray-hub-staging.minivelos.workers.dev",
        "http://localhost:5710",
        "http://127.0.0.1:5710",
    ]

    /// Dev-only extra origins parsed once from `BRIDGE_DEV_ALLOWED_ORIGINS` at
    /// first access. Comma-separated; blank entries ignored; malformed entries
    /// dropped. The frozen prod base above is left intact; `isAllowedOrigin`
    /// consults the union. Used by the local two-service harness (wrangler dev
    /// UI on :8787 + swift-server bridge). When the env var is unset, the
    /// effective allowlist is identical to `allowedOrigins` — prod is unaffected.
    static let devAllowedOrigins: Set<String> = parseDevAllowedOrigins(
        ProcessInfo.processInfo.environment["BRIDGE_DEV_ALLOWED_ORIGINS"]
    )

    /// Parse a comma-separated `BRIDGE_DEV_ALLOWED_ORIGINS` value into a
    /// normalized set. Blank/malformed entries are dropped. Never throws.
    static func parseDevAllowedOrigins(_ raw: String?) -> Set<String> {
        guard let raw, !raw.isEmpty else { return [] }
        var set = Set<String>()
        for entry in raw.split(separator: ",", omittingEmptySubsequences: false) {
            if let normalized = normalizeDevOrigin(String(entry)) {
                set.insert(normalized)
            }
        }
        return set
    }

    /// Normalize a single env-supplied origin: trim, lowercase, drop trailing
    /// slash. Returns `nil` for blank/whitespace entries or anything that does
    /// not parse as an absolute URL with scheme + host. Never throws.
    static func normalizeDevOrigin(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        var candidate = trimmed.lowercased()
        while candidate.hasSuffix("/") {
            candidate = String(candidate.dropLast())
        }
        if candidate.isEmpty { return nil }
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme, !scheme.isEmpty,
              let host = components.host, !host.isEmpty
        else {
            return nil
        }
        return candidate
    }

    /// Subprotocol prefix advertised by the leader; the per-process token is appended.
    static let subprotocolPrefix = "slicc.bridge.v1."

    /// Query-param name the launch URL uses to forward the subprotocol token to the leader.
    static let tokenQueryParam = "bridgeToken"

    /// Query-param name the launch URL uses to forward the local `/cdp` WebSocket URL.
    static let wsQueryParam = "bridge"

    /// Headers we allow on cross-origin `/api` requests from the hosted leader.
    /// Includes the `/api/fetch-proxy` transport headers (`X-Target-URL`, the
    /// forbidden-header `X-Proxy-*` bridges, `X-Slicc-Raw-Body`) so the
    /// webapp's `createProxiedFetch` can route through the local swift-server
    /// cross-origin in thin-bridge mode. Custom upstream headers (any header
    /// the agent's `curl -H …` would pass through) are reflected via
    /// `Access-Control-Request-Headers` in `resolveCorsAllowHeaders` below.
    static let corsBaseAllowHeaders: [String] = [
        "Content-Type",
        "X-Slicc-Raw-Body",
        "X-Session-Id",
        "X-Bridge-Token",
        "Authorization",
        "X-Target-URL",
        "X-Proxy-Cookie",
        "X-Proxy-Origin",
        "X-Proxy-Referer",
    ]

    /// Response headers the browser is allowed to read after a cross-origin
    /// `/api` call — must include the proxy's infrastructure-error marker
    /// (`isProxyError` reads `X-Proxy-Error`) and the forbidden-response
    /// bridge (`decodeForbiddenResponseHeaders` reads `X-Proxy-Set-Cookie`).
    static let corsExposeHeaders = "Link, X-Proxy-Error, X-Proxy-Set-Cookie"

    /// Methods exposed to the hosted leader. Must cover the FULL
    /// `/api/fetch-proxy` verb set (`fetchProxyMethods` in `APIRoutes.swift`):
    /// the proxy forwards any method, so the agent's
    /// `curl -X PROPFIND|REPORT|MKCALENDAR|PATCH …` only reaches it
    /// cross-origin from sliccy.ai if the browser's preflight sees the actual
    /// method advertised here. Standard CRUD verbs + WebDAV (RFC 4918) +
    /// CalDAV (RFC 4791). MUST stay byte-identical to `CORS_ALLOW_METHODS` in
    /// `packages/node-server/src/bridge-security.ts`.
    static let corsAllowMethods =
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT, COPY, MOVE, LOCK, UNLOCK"

    /// Request header carrying the per-process bridge token on cross-origin
    /// `/api` calls from a REMOTE allowlisted origin. The webapp's
    /// `proxied-fetch.ts` attaches it whenever a local API base origin is set;
    /// the thin-bridge CORS middleware validates it. Listed in
    /// `corsBaseAllowHeaders` so browsers don't strip it on the preflight.
    /// Mirrors `BRIDGE_TOKEN_HEADER` in `packages/node-server/src/bridge-security.ts`.
    static let bridgeTokenHeader = "X-Bridge-Token"

    /// Resolve the `Access-Control-Allow-Headers` value for a request. Starts
    /// from `corsBaseAllowHeaders` (the static set covering the documented
    /// `/api` endpoints + the `/api/fetch-proxy` transport headers) and unions
    /// in any header names from the request's `Access-Control-Request-Headers`
    /// that aren't already listed. This is the reflect-headers pattern: the
    /// agent's `bash curl -H X-Custom: …` can route through `/api/fetch-proxy`
    /// cross-origin without us having to enumerate every possible upstream
    /// header in advance. Comparison is case-insensitive; the static set's
    /// canonical casing wins on duplicates.
    static func resolveCorsAllowHeaders(_ requestHeadersHeader: String?) -> String {
        guard let requestHeadersHeader, !requestHeadersHeader.isEmpty else {
            return corsBaseAllowHeaders.joined(separator: ", ")
        }
        var seen = Set(corsBaseAllowHeaders.map { $0.lowercased() })
        var extras: [String] = []
        for raw in requestHeadersHeader.split(separator: ",", omittingEmptySubsequences: false) {
            let name = raw.trimmingCharacters(in: .whitespaces)
            if name.isEmpty { continue }
            let lower = name.lowercased()
            if seen.contains(lower) { continue }
            seen.insert(lower)
            extras.append(name)
        }
        if extras.isEmpty { return corsBaseAllowHeaders.joined(separator: ", ") }
        return (corsBaseAllowHeaders + extras).joined(separator: ", ")
    }

    /// Coarse rejection reason — mirrors `validateBridgePin` in the chrome-extension
    /// bridge SW and `bridge-security.ts`'s `reason` field. Intentionally does not
    /// tell the caller WHICH check failed.
    enum RejectionReason: String, Sendable {
        case originNotAllowed = "origin-not-allowed"
        case subprotocolMissingOrMismatched = "subprotocol-missing-or-mismatched"
    }

    struct UpgradeGateResult: Sendable, Equatable {
        let ok: Bool
        /// The subprotocol to echo back in the 101 response when `ok == true`. Always
        /// nil when `ok == false`.
        let acceptedSubprotocol: String?
        /// Reason exposed in logs for rejection. nil on success.
        let reason: RejectionReason?
    }

    /// True iff `origin` is in the bridge allowlist. The frozen prod base
    /// (`allowedOrigins`) is matched case-sensitively against the raw origin
    /// (origins are normalized lowercase by the browser before being put on the
    /// wire); the dev-only env-supplied extras (`devAllowedOrigins`, normalized
    /// lowercase + trailing-slash-stripped at load) are matched against a
    /// normalized copy of the input.
    static func isAllowedOrigin(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return false }
        if allowedOrigins.contains(origin) { return true }
        if devAllowedOrigins.isEmpty { return false }
        guard let normalized = normalizeDevOrigin(origin) else { return false }
        return devAllowedOrigins.contains(normalized)
    }

    /// True iff `origin` is a loopback host (localhost / 127.0.0.1 / ::1).
    /// Loopback allowlisted origins (e.g. the locally-served OAuth callback
    /// page at `http://localhost:5710/auth/callback` posting to
    /// `/api/oauth-result`) are exempt from the bridge-token requirement —
    /// the token's threat model is "remote allowlisted origin (sliccy.ai)
    /// with a hostile script", not "local server talking to itself". Returns
    /// `false` for nil/empty or anything that does not parse as a URL with a
    /// host; never throws. Mirrors `isLoopbackBridgeOrigin` in
    /// `packages/node-server/src/bridge-security.ts`.
    static func isLoopbackBridgeOrigin(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return false }
        guard let components = URLComponents(string: origin), let host = components.host else {
            return false
        }
        // URLComponents keeps the brackets on IPv6 hosts
        // (`http://[::1]:5710` → `[::1]`); accept both bracketed and bare.
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    /// Constant-time compare for the bridge token. Returns `false` for a nil
    /// or empty `expected`, a nil/empty `presented`, or a length mismatch —
    /// never throws. On equal lengths the comparison XOR-accumulates over all
    /// bytes (no early return on first mismatch) so timing does not leak how
    /// many leading bytes matched. Mirrors `validateBridgeToken` /
    /// `timingSafeEqual` in `packages/node-server/src/bridge-security.ts`.
    static func validateBridgeToken(_ presented: String?, _ expected: String?) -> Bool {
        guard let expected, !expected.isEmpty else { return false }
        guard let presented, !presented.isEmpty else { return false }
        let a = Array(presented.utf8)
        let b = Array(expected.utf8)
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for index in a.indices {
            diff |= a[index] ^ b[index]
        }
        return diff == 0
    }

    /// Mint a per-process bridge token. Embedded in the leader launch URL and
    /// required as the WebSocket subprotocol on `/cdp`. UUID gives 122 bits of
    /// entropy — plenty for a session-scoped capability.
    static func mintToken() -> String {
        UUID().uuidString
    }

    /// Parse the `Sec-WebSocket-Protocol` request header into a trimmed list.
    /// The header is a comma-separated list per RFC 6455.
    static func parseSubprotocolHeader(_ header: String?) -> [String] {
        guard let header, !header.isEmpty else { return [] }
        return header
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Pick the bridge subprotocol matching `expectedToken`, or nil if absent.
    /// The matching protocol is what we MUST echo back in the upgrade response
    /// (RFC 6455 §1.9) — otherwise the browser closes the socket.
    static func selectSubprotocol(_ protocols: [String], expectedToken: String) -> String? {
        guard !expectedToken.isEmpty else { return nil }
        let expected = subprotocolPrefix + expectedToken
        return protocols.contains(expected) ? expected : nil
    }

    /// Combined origin + subprotocol gate for a `/cdp` upgrade request.
    ///
    /// Returns `ok: true` only when BOTH the origin is in the allowlist AND a
    /// matching `slicc.bridge.v1.<expectedToken>` subprotocol was offered.
    static func validateUpgrade(
        origin: String?,
        subprotocolHeader: String?,
        expectedToken: String
    ) -> UpgradeGateResult {
        if !isAllowedOrigin(origin) {
            return UpgradeGateResult(ok: false, acceptedSubprotocol: nil, reason: .originNotAllowed)
        }
        let protocols = parseSubprotocolHeader(subprotocolHeader)
        guard let accepted = selectSubprotocol(protocols, expectedToken: expectedToken) else {
            return UpgradeGateResult(
                ok: false,
                acceptedSubprotocol: nil,
                reason: .subprotocolMissingOrMismatched
            )
        }
        return UpgradeGateResult(ok: true, acceptedSubprotocol: accepted, reason: nil)
    }

    /// CORS headers for an allowlisted `Origin`. Returns `nil` when the origin
    /// is not in the allowlist (caller should NOT set CORS headers).
    ///
    /// `Access-Control-Allow-Credentials: true` is included so the hosted leader
    /// can carry cookies to `/api/*` (e.g. auth) when that's added later. Today
    /// the bridge token is the auth factor, not cookies.
    ///
    /// `requestHeadersHeader` should be the request's `Access-Control-Request-Headers`
    /// value (preflight only); on a non-preflight request pass `nil` and the
    /// caller can omit it.
    static func buildCorsHeaders(origin: String?, requestHeadersHeader: String? = nil) -> HTTPFields? {
        guard isAllowedOrigin(origin), let origin else { return nil }
        var fields = HTTPFields()
        fields[HTTPField.Name("Access-Control-Allow-Origin")!] = origin
        fields[HTTPField.Name("Access-Control-Allow-Credentials")!] = "true"
        fields[HTTPField.Name("Access-Control-Allow-Methods")!] = corsAllowMethods
        fields[HTTPField.Name("Access-Control-Allow-Headers")!] = resolveCorsAllowHeaders(requestHeadersHeader)
        fields[HTTPField.Name("Access-Control-Expose-Headers")!] = corsExposeHeaders
        fields[HTTPField.Name("Vary")!] = "Origin, Access-Control-Request-Headers"
        return fields
    }

    /// PNA preflight extras. Added on OPTIONS responses for allowlisted origins
    /// when the request carries `Access-Control-Request-Private-Network: true`
    /// — Chrome blocks public→private fetch / WS otherwise.
    static func buildPnaPreflightHeaders() -> HTTPFields {
        var fields = HTTPFields()
        fields[HTTPField.Name("Access-Control-Allow-Private-Network")!] = "true"
        return fields
    }
}
