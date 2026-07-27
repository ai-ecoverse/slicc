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

    func testDeleteSecretRemovesEntryFromKeychainBlob() async throws {
        let name = secretName("DEL_TOK")
        try SecretStore.set(name: name, value: "val", domains: ["x.com"])

        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/secrets/\(name)", method: .delete) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    if case .bool(let ok) = obj["ok"] ?? .null {
                        XCTAssertTrue(ok)
                    } else {
                        XCTFail("Expected ok: true")
                    }
                    XCTAssertEqual(obj["name"]?.stringValue, name)
                    if case .bool(let fromSession) = obj["fromSession"] ?? .null {
                        XCTAssertFalse(fromSession)
                    } else {
                        XCTFail("Expected fromSession: false")
                    }
                }
                // Entry must be gone after the delete.
                XCTAssertNil(SecretStore.get(name: name))
            }
        }
    }

    func testDeleteSecretReturnsNotFoundForUnknownName() async throws {
        let name = secretName("DEL_MISS")

        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/secrets/\(name)", method: .delete) { response in
                    XCTAssertEqual(response.status, .notFound)
                    let obj = try self.decodeJSONObject(from: response.body)
                    XCTAssertNotNil(obj["error"]?.stringValue)
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
                let body = #"{"providerId":"github","accessToken":"ghp_realtoken","domains":["github.com"]}"#
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
                        XCTAssertEqual(masked.count, "ghp_realtoken".count)
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

    // MARK: - Scrub route

    func testScrubReplacesRealValuesWithMasked() async throws {
        let injector = SecretInjector(secrets: [
            .init(
                name: "GH",
                realValue: "ghp_realSecret123",
                maskedValue: "ghp_maskedAAA0001",
                domains: ["github.com"]
            ),
        ])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"text":"token: ghp_realSecret123 done"}"#
                try await client.execute(
                    uri: "/api/secrets/scrub",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(obj["text"]?.stringValue, "token: ghp_maskedAAA0001 done")
                }
            }
        }
    }

    func testScrubHandlesBodyLargerThanDefaultUploadLimit() async throws {
        // Regression: Hummingbird's default ~2 MiB maxUploadSize used to make the
        // scrub route 400 on large tool results, so oversized output skipped
        // real→masked scrubbing. The handler now collects the body explicitly
        // (>=32 MiB, matching node-server), so a ~3 MiB payload must still scrub.
        let injector = SecretInjector(secrets: [
            .init(
                name: "GH",
                realValue: "ghp_realSecret123",
                maskedValue: "ghp_maskedAAA0001",
                domains: ["github.com"]
            ),
        ])
        let filler = String(repeating: "a", count: 3 * 1024 * 1024)
        let text = "\(filler) token: ghp_realSecret123 done"
        let bodyData = try JSONEncoder().encode(["text": text])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/secrets/scrub",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(bytes: bodyData)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(obj["text"]?.stringValue, "\(filler) token: ghp_maskedAAA0001 done")
                }
            }
        }
    }

    func testScrubReturnsInputUnchangedWhenNoSecrets() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"text":"nothing to scrub here"}"#
                try await client.execute(
                    uri: "/api/secrets/scrub",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(obj["text"]?.stringValue, "nothing to scrub here")
                }
            }
        }
    }

    func testScrubRejectsNonStringText() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"text":123}"#
                try await client.execute(
                    uri: "/api/secrets/scrub",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testScrubRejectsMissingText() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = "{}"
                try await client.execute(
                    uri: "/api/secrets/scrub",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    // MARK: - Helpers

    private func makeConfig() -> ServerConfig {
        .init(
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

    // MARK: - redact-export tests

    func testRedactExportReplacesRealValuesWithAnonymousMarkers() async throws {
        let injector = SecretInjector(secrets: [
            .init(
                name: "GH",
                realValue: "ghp_realSecret123",
                maskedValue: "ghp_maskedAAA0001",
                domains: ["github.com"]
            ),
        ])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let payload = try JSONEncoder().encode([
                    "texts": ["token: ghp_realSecret123 here", "also ghp_maskedAAA0001 masked"]
                ])
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(bytes: payload)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    guard case .array(let texts) = obj["texts"] else {
                        XCTFail("Expected texts array")
                        return
                    }
                    XCTAssertEqual(texts.count, 2)
                    let text0 = texts[0].stringValue ?? ""
                    let text1 = texts[1].stringValue ?? ""
                    XCTAssertFalse(text0.contains("ghp_realSecret123"), "Must not contain real value")
                    XCTAssertFalse(text1.contains("ghp_maskedAAA0001"), "Must not contain masked value")
                    XCTAssertTrue(text0.contains("⟦REDACTED:known-secret:"), "Must contain marker")
                    XCTAssertTrue(text1.contains("⟦REDACTED:known-secret:"), "Must contain marker")
                    guard case .number(let count) = obj["redactionCount"] else {
                        XCTFail("Expected redactionCount number")
                        return
                    }
                    XCTAssertGreaterThanOrEqual(count, 2.0)
                }
            }
        }
    }

    func testRedactExportRedactsShortSecretByRealValueOnly() async throws {
        // A short secret (isMaskable: false) has no distinct masked form.
        // Its real value must still be replaced during export with a k<n> marker.
        let shortVal = String(repeating: "z", count: 3) // well below minMaskableSecretLength=9
        let injector = SecretInjector(secrets: [
            .init(
                name: "SHORT_KEY",
                realValue: shortVal,
                maskedValue: shortVal, // identity masking for short secrets
                domains: [],
                isMaskable: false
            ),
        ])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let payload = try JSONEncoder().encode([
                    "texts": ["prefix \(shortVal) suffix"]
                ])
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(bytes: payload)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    guard case .array(let texts) = obj["texts"] else {
                        XCTFail("Expected texts array")
                        return
                    }
                    XCTAssertEqual(texts.count, 1)
                    let text = texts[0].stringValue ?? ""
                    XCTAssertFalse(text.contains(shortVal), "Must not contain short secret real value")
                    XCTAssertTrue(text.contains("⟦REDACTED:known-secret:"), "Must contain marker")
                }
            }
        }
    }

    func testRedactExportShortSecretMarkerContinuesAfterMaskableMarker() async throws {
        // Maskable secret → k1, short secret → k2 (index continues)
        let shortVal = String(repeating: "q", count: 4) // below minMaskableSecretLength=9
        let injector = SecretInjector(secrets: [
            .init(
                name: "LONG_TOKEN",
                realValue: "ghp_realSecret123",
                maskedValue: "ghp_maskedAAA0001",
                domains: ["github.com"]
            ),
            .init(
                name: "SHORT_KEY",
                realValue: shortVal,
                maskedValue: shortVal,
                domains: [],
                isMaskable: false
            ),
        ])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let payload = try JSONEncoder().encode([
                    "texts": ["ghp_realSecret123 and \(shortVal)"]
                ])
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(bytes: payload)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    guard case .array(let texts) = obj["texts"] else {
                        XCTFail("Expected texts array")
                        return
                    }
                    let text = texts[0].stringValue ?? ""
                    XCTAssertTrue(text.contains("⟦REDACTED:known-secret:k1⟧"), "Maskable secret must get k1")
                    XCTAssertTrue(text.contains("⟦REDACTED:known-secret:k2⟧"), "Short secret must get k2")
                    XCTAssertFalse(text.contains("ghp_realSecret123"))
                    XCTAssertFalse(text.contains(shortVal))
                }
            }
        }
    }

    func testRedactExportReturnsBadRequestForMissingTexts() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"other":"field"}"#
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testRedactExportReturnsBadRequestForNonArrayTexts() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"texts":"not-an-array"}"#
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testRedactExportReturnsEmptyTextsForEmptyInput() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = #"{"texts":[]}"#
                try await client.execute(
                    uri: "/api/secrets/redact-export",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                    let obj = try self.decodeJSONObject(from: response.body)
                    guard case .array(let texts) = obj["texts"] else {
                        XCTFail("Expected texts array")
                        return
                    }
                    XCTAssertEqual(texts.count, 0)
                    guard case .number(let count) = obj["redactionCount"] else {
                        XCTFail("Expected redactionCount")
                        return
                    }
                    XCTAssertEqual(count, 0.0)
                }
            }
        }
    }
}

