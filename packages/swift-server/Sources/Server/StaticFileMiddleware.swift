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
            var response = try await self.fileMiddleware.handle(request, context: context, next: next)
            Self.applyCacheHeaders(path: request.uri.path, response: &response)
            return response
        } catch {
            guard Self.shouldServeSPAFallback(method: request.method, path: request.uri.path, error: error) else {
                throw error
            }

            let fallbackRequest = self.rewritingRequestPath(request, to: self.fallbackFilePath)
            var fallbackResponse = try await self.fileMiddleware.handle(fallbackRequest, context: context) { _, _ in
                throw HTTPError(.notFound)
            }
            Self.applyCacheHeaders(path: self.fallbackFilePath, response: &fallbackResponse)
            return fallbackResponse
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

    /// Mirrors the Express middleware in `packages/node-server/src/index.ts`
    /// (PR #710). Without these headers, browsers apply heuristic freshness
    /// to `index.html` and the unhashed shells based on `Last-Modified`, so
    /// a long-running tab keeps using cached HTML after a server rebuild
    /// and every dynamic `import()` of `/assets/<old-hash>.js` 404s until
    /// the user hard-refreshes.
    ///
    /// Three buckets:
    /// - `/llm-proxy-sw.js`, `/preview-sw.js`: `no-store` so the browser
    ///   always pulls the latest SW bytes on navigation/registration,
    ///   plus `Service-Worker-Allowed: /` so the SW can claim a wider
    ///   scope than its serve path. `llm-proxy-sw.js` actually needs
    ///   the root scope; `preview-sw.js` registers at `/preview/`
    ///   (narrower), but Node sends the header for both — matching here
    ///   keeps the two implementations byte-for-byte identical and the
    ///   broader allowance is harmless.
    /// - `/assets/*`: Vite emits content-hashed filenames here, so each
    ///   URL is byte-for-byte immutable — cache forever to avoid
    ///   revalidation round-trips.
    /// - Everything else (`index.html`, manifest, `sprinkle-sandbox.html`,
    ///   favicon, fonts, ...): `no-cache` forces a conditional revalidation
    ///   on every load. Cheap (304 on unchanged) and guarantees tabs pick
    ///   up the new asset references after a rebuild.
    static func applyCacheHeaders(path: String, response: inout Response) {
        if path == "/llm-proxy-sw.js" || path == "/preview-sw.js" {
            response.headers[HTTPField.Name("Service-Worker-Allowed")!] = "/"
        }
        response.headers[HTTPField.Name.cacheControl] = cacheControlValue(forPath: path)
    }

    static func cacheControlValue(forPath path: String) -> String {
        if path == "/llm-proxy-sw.js" || path == "/preview-sw.js" {
            return "no-store"
        }
        if path.hasPrefix("/assets/") {
            return "public, max-age=31536000, immutable"
        }
        return "no-cache"
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