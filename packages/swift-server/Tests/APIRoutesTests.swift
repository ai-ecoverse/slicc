import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdTesting
import XCTest
@testable import slicc_server

final class APIRoutesTests: XCTestCase {
    func testRuntimeConfigReturnsConfiguredValues() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(
                    leadWorkerBaseUrl: "https://worker.example",
                    joinUrl: "https://join.example/session"
                ),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        [
                            "trayWorkerBaseUrl": .string("https://worker.example"),
                            "trayJoinUrl": .string("https://join.example/session"),
                        ]
                    )
                }
            }
        }
    }

    func testRuntimeConfigDefaultsToProductionUrlWhenNotDev() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(dev: false),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["trayWorkerBaseUrl"], .string("https://www.sliccy.ai"))
                    XCTAssertEqual(body["trayJoinUrl"], .null)
                }
            }
        }
    }

    func testRuntimeConfigReturnsNullUrlInDevMode() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(dev: true),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["trayWorkerBaseUrl"], .null)
                    XCTAssertEqual(body["trayJoinUrl"], .null)
                }
            }
        }
    }

    func testTrayStatusForwardsBrowserResponse() async throws {
        try await self.withHTTPClient { httpClient in
            let lickSystem = LickSystem()
            await self.attachResponderClient(to: lickSystem) { request in
                XCTAssertEqual(request["type"], .string("tray_status"))
                return .object(["leader": .bool(true)])
            }

            let router = Router()
            registerAPIRoutes(router: router, lickSystem: lickSystem, config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/tray-status", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(try self.decodeJSONObject(from: response.body), ["leader": .bool(true)])
                }
            }
        }
    }

    func testTrayStatusReturnsServiceUnavailableWithoutBrowser() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/tray-status", method: .get) { response in
                    XCTAssertEqual(response.status, .serviceUnavailable)
                    XCTAssertEqual(try self.decodeJSONObject(from: response.body)["error"], .string("No browser connected"))
                }
            }
        }
    }

    func testOAuthResultRoundTripsAndClears() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/oauth-result",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"redirectUrl":"https://callback.example","error":"denied"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                }

                try await client.execute(uri: "/api/oauth-result", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        [
                            "redirectUrl": .string("https://callback.example"),
                            "error": .string("denied"),
                        ]
                    )
                }

                try await client.execute(uri: "/api/oauth-result", method: .get) { response in
                    XCTAssertEqual(response.status, .noContent)
                }
            }
        }
    }

    private func makeConfig(
        dev: Bool = false,
        leadWorkerBaseUrl: String? = nil,
        joinUrl: String? = nil
    ) -> ServerConfig {
        .init(
            dev: dev,
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: leadWorkerBaseUrl != nil,
            leadWorkerBaseUrl: leadWorkerBaseUrl,
            leadWorkerBaseURL: leadWorkerBaseUrl.flatMap(URL.init(string:)),
            profile: nil,
            join: joinUrl != nil,
            joinUrl: joinUrl,
            joinURL: joinUrl.flatMap(URL.init(string:)),
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            staticRoot: nil
        )
    }

    private func decodeJSONObject(from body: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: body).utf8))
    }

    private func withHTTPClient(
        _ body: (HTTPClient) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            try await body(httpClient)
            try await httpClient.shutdown()
        } catch {
            try? await httpClient.shutdown()
            throw error
        }
    }

    private func attachResponderClient(
        to lickSystem: LickSystem,
        responder: @escaping @Sendable (LickSystem.JSONObject) throws -> LickSystem.JSONValue
    ) async {
        let client = WebSocketClient { text in
            let request = try LickSystem.decode(text)
            let requestId = try XCTUnwrap(request["requestId"]?.stringValue)
            let response = try responder(request)
            let payload = try LickSystem.encode([
                "type": .string("response"),
                "requestId": .string(requestId),
                "data": response,
            ])
            await lickSystem.handleMessage(text: payload)
        }
        await lickSystem.addClient(client)
    }
}