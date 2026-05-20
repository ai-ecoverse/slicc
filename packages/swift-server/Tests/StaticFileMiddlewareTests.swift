import Hummingbird
import HTTPTypes
import XCTest
@testable import slicc_server

@available(macOS 14, *)
final class StaticFileMiddlewareTests: XCTestCase {
    func testReservedPathsBypassSPA() {
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/api/runtime-config"))
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/auth/callback"))
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/webhooks/test"))
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/cdp"))
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/licks-ws"))
        XCTAssertFalse(StaticFileMiddleware<BasicRequestContext>.isReservedPath("/dashboard"))
    }

    func testSPAFallbackOnlyAppliesToGetNotFoundOnNonReservedPaths() {
        XCTAssertTrue(StaticFileMiddleware<BasicRequestContext>.shouldServeSPAFallback(
            method: .get,
            path: "/dashboard",
            error: HTTPError(.notFound)
        ))
        XCTAssertFalse(StaticFileMiddleware<BasicRequestContext>.shouldServeSPAFallback(
            method: .head,
            path: "/dashboard",
            error: HTTPError(.notFound)
        ))
        XCTAssertFalse(StaticFileMiddleware<BasicRequestContext>.shouldServeSPAFallback(
            method: .get,
            path: "/api/runtime-config",
            error: HTTPError(.notFound)
        ))
        XCTAssertFalse(StaticFileMiddleware<BasicRequestContext>.shouldServeSPAFallback(
            method: .get,
            path: "/dashboard",
            error: HTTPError(.internalServerError)
        ))
    }

    func testCacheControlValueForServiceWorkers() {
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/llm-proxy-sw.js"),
            "no-store"
        )
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/preview-sw.js"),
            "no-store"
        )
    }

    func testCacheControlValueForHashedAssets() {
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/assets/anthropic-4ASJTRhO.js"),
            "public, max-age=31536000, immutable"
        )
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/assets/nested/chunk.css"),
            "public, max-age=31536000, immutable"
        )
    }

    func testCacheControlValueForUnhashedShells() {
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/index.html"),
            "no-cache"
        )
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/sprinkle-sandbox.html"),
            "no-cache"
        )
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/manifest.webmanifest"),
            "no-cache"
        )
        XCTAssertEqual(
            StaticFileMiddleware<BasicRequestContext>.cacheControlValue(forPath: "/favicon.ico"),
            "no-cache"
        )
    }

    func testApplyCacheHeadersServiceWorkerAllowedOnBothSWPaths() {
        var response = Response(status: .ok)
        StaticFileMiddleware<BasicRequestContext>.applyCacheHeaders(path: "/llm-proxy-sw.js", response: &response)
        XCTAssertEqual(response.headers[HTTPField.Name.cacheControl], "no-store")
        XCTAssertEqual(response.headers[HTTPField.Name("Service-Worker-Allowed")!], "/")

        var previewResponse = Response(status: .ok)
        StaticFileMiddleware<BasicRequestContext>.applyCacheHeaders(path: "/preview-sw.js", response: &previewResponse)
        XCTAssertEqual(previewResponse.headers[HTTPField.Name.cacheControl], "no-store")
        XCTAssertEqual(previewResponse.headers[HTTPField.Name("Service-Worker-Allowed")!], "/")

        var assetResponse = Response(status: .ok)
        StaticFileMiddleware<BasicRequestContext>.applyCacheHeaders(path: "/assets/x.js", response: &assetResponse)
        XCTAssertEqual(assetResponse.headers[HTTPField.Name.cacheControl], "public, max-age=31536000, immutable")
        XCTAssertNil(assetResponse.headers[HTTPField.Name("Service-Worker-Allowed")!])

        var indexResponse = Response(status: .ok)
        StaticFileMiddleware<BasicRequestContext>.applyCacheHeaders(path: "/index.html", response: &indexResponse)
        XCTAssertEqual(indexResponse.headers[HTTPField.Name.cacheControl], "no-cache")
        XCTAssertNil(indexResponse.headers[HTTPField.Name("Service-Worker-Allowed")!])
    }
}