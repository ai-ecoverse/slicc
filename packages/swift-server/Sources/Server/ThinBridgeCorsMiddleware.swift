import Hummingbird
import HTTPTypes
import NIOCore

/// Thin-bridge CORS + PNA middleware. The hosted leader at sliccy.ai is a
/// cross-origin caller, so headers go on every response for allowlisted
/// origins (so the pre-WS preflight and every `/api/*` call succeed);
/// OPTIONS from an allowlisted origin short-circuits to 204 with the PNA
/// opt-in. Non-allowlisted origins fall through with no CORS headers, which
/// preserves same-origin (localhost) behavior unchanged.
///
/// Additionally enforces the per-process bridge token on cross-origin
/// `/api/*` requests from REMOTE allowlisted origins (sliccy.ai) — the origin
/// allowlist alone is insufficient because any script on a remote allowlisted
/// origin could otherwise reach the local server's `/api` surface (secrets,
/// fetch-proxy, etc.). Loopback allowlisted origins are exempt (they originate
/// from this same server), and OPTIONS preflights are exempt because browsers
/// strip custom headers from preflights.
///
/// Mirrors `createThinBridgeCorsMiddleware()` in
/// `packages/node-server/src/index.ts`.
struct ThinBridgeCorsMiddleware<Context: RequestContext>: RouterMiddleware {
    private static var maxAgeHeader: HTTPField.Name { HTTPField.Name("Access-Control-Max-Age")! }
    private static var contentTypeHeader: HTTPField.Name { .contentType }

    /// Per-process bridge token validated on cross-origin `/api/*` calls from
    /// remote allowlisted origins. Nil disables the gate (legacy/non-thin
    /// modes), matching node-server passing `bridgeToken = null`.
    let bridgeToken: String?

    init(bridgeToken: String? = nil) {
        self.bridgeToken = bridgeToken
    }

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let origin = request.headers[.origin]
        let requestHeadersHeader = request.headers[HTTPField.Name("Access-Control-Request-Headers")!]
        let corsHeaders = BridgeSecurity.buildCorsHeaders(
            origin: origin,
            requestHeadersHeader: requestHeadersHeader
        )

        // OPTIONS preflight from an allowlisted origin: short-circuit to 204
        // with CORS + PNA headers. Non-allowlisted OPTIONS falls through.
        // Kept BEFORE the token gate — browsers strip custom headers (incl.
        // X-Bridge-Token) from preflights, so OPTIONS must never require it.
        if request.method == .options, let corsHeaders {
            var responseHeaders = corsHeaders
            for field in BridgeSecurity.buildPnaPreflightHeaders() {
                responseHeaders[field.name] = field.value
            }
            responseHeaders[Self.maxAgeHeader] = "600"
            return Response(status: .noContent, headers: responseHeaders)
        }

        // Token gate on /api/* from remote allowlisted origins. `corsHeaders`
        // is only non-nil when the Origin is in the allowlist; loopback
        // callers (localhost/127.0.0.1) and no-Origin callers fall through
        // unchanged. The 403 still carries the CORS headers so the browser
        // can read the error cross-origin.
        if let corsHeaders,
           request.uri.path.hasPrefix("/api/"),
           !BridgeSecurity.isLoopbackBridgeOrigin(origin),
           !BridgeSecurity.validateBridgeToken(
               request.headers[HTTPField.Name(BridgeSecurity.bridgeTokenHeader)!],
               bridgeToken
           ) {
            var responseHeaders = corsHeaders
            responseHeaders[Self.contentTypeHeader] = "application/json"
            return Response(
                status: .forbidden,
                headers: responseHeaders,
                body: .init(byteBuffer: ByteBuffer(string: #"{"error":"bridge-token-required"}"#))
            )
        }

        var response = try await next(request, context)
        if let corsHeaders {
            for field in corsHeaders {
                response.headers[field.name] = field.value
            }
        }
        return response
    }
}
