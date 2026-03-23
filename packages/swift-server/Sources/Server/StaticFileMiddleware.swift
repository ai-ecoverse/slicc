import Foundation
import Hummingbird
import HTTPTypes
import Logging

@available(macOS 14, *)
struct StaticFileMiddleware<Context: RequestContext>: RouterMiddleware {
    static var defaultStaticRoot: String { "dist/ui" }

    let staticRoot: String
    let fallbackFilePath: String
    private let fileMiddleware: FileMiddleware<Context, LocalFileSystem>

    init(
        staticRoot: String = Self.defaultStaticRoot,
        fallbackFilePath: String = "/index.html",
        logger: Logger = Logger(label: "slicc.static-files")
    ) {
        self.staticRoot = staticRoot
        self.fallbackFilePath = fallbackFilePath.hasPrefix("/") ? fallbackFilePath : "/\(fallbackFilePath)"
        self.fileMiddleware = FileMiddleware<Context, LocalFileSystem>(
            staticRoot,
            searchForIndexHtml: false,
            logger: logger
        )
        .withAdditionalMediaTypes(forFileExtensions: [
            "map": MediaType(type: .application, subType: "json"),
            "mjs": MediaType(type: .text, subType: "javascript"),
            "wasm": MediaType(type: .application, subType: "wasm"),
        ])
    }

    func handle(_ request: Request, context: Context, next: (Request, Context) async throws -> Response) async throws -> Response {
        if Self.isReservedPath(request.uri.path) {
            return try await next(request, context)
        }

        do {
            return try await self.fileMiddleware.handle(request, context: context, next: next)
        } catch {
            guard Self.shouldServeSPAFallback(method: request.method, path: request.uri.path, error: error) else {
                throw error
            }

            let fallbackRequest = self.rewritingRequestPath(request, to: self.fallbackFilePath)
            return try await self.fileMiddleware.handle(fallbackRequest, context: context) { _, _ in
                throw HTTPError(.notFound)
            }
        }
    }

    private func rewritingRequestPath(_ request: Request, to path: String) -> Request {
        var head = request.head
        head.path = path
        return Request(head: head, body: request.body)
    }
}

@available(macOS 14, *)
extension StaticFileMiddleware {
    static func shouldServeSPAFallback(method: HTTPRequest.Method, path: String, error: Error) -> Bool {
        guard method == .get else { return false }
        guard !isReservedPath(path) else { return false }
        guard let responseError = error as? any HTTPResponseError else { return false }
        return responseError.status == .notFound
    }

    static func isReservedPath(_ path: String) -> Bool {
        path == "/cdp"
            || path == "/licks-ws"
            || path.hasPrefix("/api/")
            || path == "/api"
            || path.hasPrefix("/auth/")
            || path == "/auth"
            || path.hasPrefix("/webhooks/")
            || path == "/webhooks"
    }
}