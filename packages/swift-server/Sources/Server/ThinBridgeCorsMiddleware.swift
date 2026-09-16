import HTTPTypes
import Hummingbird
import NIOCore

struct ThinBridgeCorsMiddleware<Context: RequestContext>: RouterMiddleware {
    private static var maxAgeHeader: HTTPField.Name { HTTPField.Name("Access-Control-Max-Age")! }
    private static var contentTypeHeader: HTTPField.Name { .contentType }

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

        if request.method == .options, let corsHeaders {
            var responseHeaders = corsHeaders
            for field in BridgeSecurity.buildPnaPreflightHeaders() {
                responseHeaders[field.name] = field.value
            }
            responseHeaders[Self.maxAgeHeader] = BridgeSecurity.preflightMaxAge(request.uri.path)
            return Response(status: .noContent, headers: responseHeaders)
        }

        if let corsHeaders,
            request.uri.path.hasPrefix("/api/"),
            !BridgeSecurity.isLoopbackBridgeOrigin(origin),
            !BridgeSecurity.validateBridgeToken(
                request.headers[HTTPField.Name(BridgeSecurity.bridgeTokenHeader)!],
                bridgeToken
            )
        {
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

            let exposeHeader = HTTPField.Name("Access-Control-Expose-Headers")!
            let routeExpose = response.headers[exposeHeader]
            for field in corsHeaders {
                if field.name == exposeHeader, routeExpose != nil {
                    continue
                }
                response.headers[field.name] = field.value
            }
        }
        return response
    }
}
