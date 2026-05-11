import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdTesting
import XCTest
@testable import slicc_server

final class SecretAPIRoutesTests: XCTestCase {
    /// Unique prefix per test run so parallel/repeated runs don't collide.
    private let prefix = "APITEST_\(UUID().uuidString.prefix(8))_"

    private func secretName(_ base: String) -> String { prefix + base }

    override func tearDown() {
        for entry in SecretStore.list() where entry.name.hasPrefix(prefix) {
            try? SecretStore.delete(name: entry.name)
        }
        super.tearDown()
    }

    func testListSecretsReturnsNamesAndDomains() async throws {
        let name = secretName("LIST_TOK")
        try SecretStore.set(name: name, value: "secret_val", domains: ["api.example.com"])

        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/secrets", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONArray(from: response.body)
                    let entry = body.first(where: { item in
                        if case .object(let obj) = item, obj["name"]?.stringValue == name { return true }
                        return false
                    })
                    XCTAssertNotNil(entry, "Expected to find secret \(name) in list")
                    if case .object(let obj) = entry {
                        // Verify domains are present
                        if case .array(let domains) = obj["domains"] {
                            XCTAssertEqual(domains, [.string("api.example.com")])
                        } else {
                            XCTFail("Expected domains array")
                        }
                        // Verify value is NOT present
                        XCTAssertNil(obj["value"], "Secret value must never be returned")
                    }
                }
            }
        }
    }

    func testPostSecretRouteIsRemoved() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"name":"SHOULD_FAIL","value":"v","domains":["d.com"]}"#
                try await client.execute(
                    uri: "/api/secrets",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    // Route no longer exists — expect 404
                    XCTAssertEqual(response.status, .notFound)
                }
            }
        }
    }

    func testDeleteSecretRouteIsRemoved() async throws {
        let name = secretName("DEL_TOK")
        try SecretStore.set(name: name, value: "val", domains: ["x.com"])

        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/secrets/\(name)", method: .delete) { response in
                    // Route no longer exists — expect 404
                    XCTAssertEqual(response.status, .notFound)
                }
            }
        }
    }

    // MARK: - OAuth secret routes

    func testOAuthUpdatePostHappyPath() async throws {
        let oauthStore = OAuthSecretStore()
        let injector = SecretInjector(sessionId: "fixed-session-oauth", oauthStore: oauthStore)
        await injector.reload()
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector,
                oauthStore: oauthStore
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"providerId":"github","accessToken":"ghp_real","domains":["github.com"]}"#
                try await client.execute(
                    uri: "/api/secrets/oauth-update",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(obj["providerId"]?.stringValue, "github")
                    XCTAssertEqual(obj["name"]?.stringValue, "oauth.github.token")
                    // maskedValue should be the format-preserving mask of the real token.
                    if case .string(let masked) = obj["maskedValue"] ?? .null {
                        XCTAssertTrue(masked.hasPrefix("ghp_"))
                        XCTAssertEqual(masked.count, "ghp_real".count)
                    } else {
                        XCTFail("Expected maskedValue string")
                    }
                    if case .array(let domains) = obj["domains"] ?? .null {
                        XCTAssertEqual(domains, [.string("github.com")])
                    } else {
                        XCTFail("Expected domains array")
                    }
                }
            }
        }
    }

    func testOAuthUpdatePostRejectsMissingDomains() async throws {
        let oauthStore = OAuthSecretStore()
        let injector = SecretInjector(sessionId: "fixed-session-oauth", oauthStore: oauthStore)
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector,
                oauthStore: oauthStore
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                // Body is missing the `domains` key entirely.
                let body = #"{"providerId":"github","accessToken":"ghp_real"}"#
                try await client.execute(
                    uri: "/api/secrets/oauth-update",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testOAuthUpdatePostRejectsMalformedJSON() async throws {
        let oauthStore = OAuthSecretStore()
        let injector = SecretInjector(sessionId: "fixed-session-oauth", oauthStore: oauthStore)
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector,
                oauthStore: oauthStore
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = "{not valid json"
                try await client.execute(
                    uri: "/api/secrets/oauth-update",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testOAuthDeleteHappyPath() async throws {
        let oauthStore = OAuthSecretStore()
        try await oauthStore.set(
            name: "oauth.github.token",
            value: "ghp_real",
            domains: ["github.com"]
        )
        let injector = SecretInjector(sessionId: "fixed-session-oauth", oauthStore: oauthStore)
        await injector.reload()
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector,
                oauthStore: oauthStore
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/secrets/oauth/github",
                    method: .delete
                ) { response in
                    XCTAssertEqual(response.status, .noContent)
                }
            }
        }
        let remaining = await oauthStore.get(name: "oauth.github.token")
        XCTAssertNil(remaining)
    }

    func testOAuthDelete404OnUnknownProvider() async throws {
        let oauthStore = OAuthSecretStore()
        let injector = SecretInjector(sessionId: "fixed-session-oauth", oauthStore: oauthStore)
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector,
                oauthStore: oauthStore
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/secrets/oauth/never-registered",
                    method: .delete
                ) { response in
                    XCTAssertEqual(response.status, .notFound)
                }
            }
        }
    }

    // MARK: - Helpers

    private func makeConfig() -> ServerConfig {
        .init(
            dev: true,
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: false,
            leadWorkerBaseUrl: nil,
            leadWorkerBaseURL: nil,
            profile: nil,
            join: false,
            joinUrl: nil,
            joinURL: nil,
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            staticRoot: nil,
            envFile: nil,
            envFileURL: nil
        )
    }

    private func decodeJSONObject(from body: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: body).utf8))
    }

    private func decodeJSONArray(from body: ByteBuffer) throws -> [LickSystem.JSONValue] {
        try JSONDecoder().decode([LickSystem.JSONValue].self, from: Data(String(buffer: body).utf8))
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
}

