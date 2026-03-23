import Hummingbird
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
}