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

    /// Subprotocol prefix advertised by the leader; the per-process token is appended.
    static let subprotocolPrefix = "slicc.bridge.v1."

    /// Query-param name the launch URL uses to forward the subprotocol token to the leader.
    static let tokenQueryParam = "bridgeToken"

    /// Query-param name the launch URL uses to forward the local `/cdp` WebSocket URL.
    static let wsQueryParam = "bridge"

    /// Headers we allow on cross-origin `/api` requests from the hosted leader.
    static let corsAllowHeaders = "Content-Type, X-Slicc-Raw-Body, X-Session-Id, X-Bridge-Token, Authorization"

    /// Methods exposed to the hosted leader.
    static let corsAllowMethods = "GET, POST, PUT, DELETE, OPTIONS"

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

    /// True iff `origin` is in the bridge allowlist. Case-sensitive (origins are
    /// normalized lowercase by the browser before being put on the wire).
    static func isAllowedOrigin(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return false }
        return allowedOrigins.contains(origin)
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
    static func buildCorsHeaders(origin: String?) -> HTTPFields? {
        guard isAllowedOrigin(origin), let origin else { return nil }
        var fields = HTTPFields()
        fields[HTTPField.Name("Access-Control-Allow-Origin")!] = origin
        fields[HTTPField.Name("Access-Control-Allow-Credentials")!] = "true"
        fields[HTTPField.Name("Access-Control-Allow-Methods")!] = corsAllowMethods
        fields[HTTPField.Name("Access-Control-Allow-Headers")!] = corsAllowHeaders
        fields[HTTPField.Name("Access-Control-Expose-Headers")!] = "Link"
        fields[HTTPField.Name("Vary")!] = "Origin"
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
