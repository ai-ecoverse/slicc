import Hummingbird
import HummingbirdTesting
import HTTPTypes
import NIOCore
import XCTest
@testable import slicc_server

/// HTTP-level coverage for the thin-bridge CORS + PNA middleware. Parity
/// matters with `createThinBridgeCorsMiddleware()` in
/// `packages/node-server/src/index.ts` — the same hosted webapp client
/// must succeed on both runtimes.
final class ThinBridgeCorsMiddlewareTests: XCTestCase {
    private static let acAllowOrigin = HTTPField.Name("Access-Control-Allow-Origin")!
    private static let acAllowCredentials = HTTPField.Name("Access-Control-Allow-Credentials")!
    private static let acAllowPrivateNetwork = HTTPField.Name("Access-Control-Allow-Private-Network")!
    private static let acAllowMethods = HTTPField.Name("Access-Control-Allow-Methods")!
    private static let acMaxAge = HTTPField.Name("Access-Control-Max-Age")!

    private func buildRouter() -> Router<BasicRequestContext> {
        let router = Router(context: BasicRequestContext.self)
        router.middlewares.add(ThinBridgeCorsMiddleware<BasicRequestContext>())
        router.get("/api/status") { _, _ in
            Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: #"{"ok":true}"#)))
        }
        return router
    }

    func testGetFromAllowlistedOriginGetsCorsHeaders() async throws {
        let app = Application(responder: self.buildRouter().buildResponder())
        try await app.test(.router) { client in
            try await client.execute(
                uri: "/api/status",
                method: .get,
                headers: [.origin: "https://www.sliccy.ai"]
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(response.headers[Self.acAllowOrigin], "https://www.sliccy.ai")
                XCTAssertEqual(response.headers[Self.acAllowCredentials], "true")
            }
        }
    }

    func testGetFromDisallowedOriginPassesThroughWithoutCors() async throws {
        let app = Application(responder: self.buildRouter().buildResponder())
        try await app.test(.router) { client in
            try await client.execute(
                uri: "/api/status",
                method: .get,
                headers: [.origin: "https://evil.example.com"]
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertNil(response.headers[Self.acAllowOrigin])
            }
        }
    }

    func testOptionsPreflightFromAllowlistedOriginReturnsNoContentWithPnaHeader() async throws {
        let app = Application(responder: self.buildRouter().buildResponder())
        try await app.test(.router) { client in
            try await client.execute(
                uri: "/api/status",
                method: .options,
                headers: [.origin: "https://www.sliccy.ai"]
            ) { response in
                XCTAssertEqual(response.status, .noContent)
                XCTAssertEqual(response.headers[Self.acAllowOrigin], "https://www.sliccy.ai")
                XCTAssertEqual(response.headers[Self.acAllowPrivateNetwork], "true")
                XCTAssertEqual(response.headers[Self.acAllowMethods], "GET, POST, PUT, DELETE, OPTIONS")
                XCTAssertEqual(response.headers[Self.acMaxAge], "600")
            }
        }
    }

    func testOptionsPreflightFromDisallowedOriginDoesNotLeakCors() async throws {
        let app = Application(responder: self.buildRouter().buildResponder())
        try await app.test(.router) { client in
            try await client.execute(
                uri: "/api/status",
                method: .options,
                headers: [.origin: "https://evil.example.com"]
            ) { response in
                // The router has no OPTIONS handler so we get 404/405, but the
                // critical assertion is "no CORS/PNA leak to disallowed origins".
                XCTAssertNil(response.headers[Self.acAllowOrigin])
                XCTAssertNil(response.headers[Self.acAllowPrivateNetwork])
            }
        }
    }
}
