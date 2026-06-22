import Hummingbird
import HTTPTypes

/// Thin-bridge CORS + PNA middleware. The hosted leader at sliccy.ai is a
/// cross-origin caller, so headers go on every response for allowlisted
/// origins (so the pre-WS preflight and every `/api/*` call succeed);
/// OPTIONS from an allowlisted origin short-circuits to 204 with the PNA
/// opt-in. Non-allowlisted origins fall through with no CORS headers, which
/// preserves same-origin (localhost) behavior unchanged.
///
/// Mirrors `createThinBridgeCorsMiddleware()` in
/// `packages/node-server/src/index.ts`.
struct ThinBridgeCorsMiddleware<Context: RequestContext>: RouterMiddleware {
    private static var maxAgeHeader: HTTPField.Name { HTTPField.Name("Access-Control-Max-Age")! }

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
        if request.method == .options, let corsHeaders {
            var responseHeaders = corsHeaders
            for field in BridgeSecurity.buildPnaPreflightHeaders() {
                responseHeaders[field.name] = field.value
            }
            responseHeaders[Self.maxAgeHeader] = "600"
            return Response(status: .noContent, headers: responseHeaders)
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
