import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import XCTest

@testable import slicc_server

final class SessionSecretAPIRoutesTests: XCTestCase {
    private static let allowOrigin = HTTPField.Name("Access-Control-Allow-Origin")!
    private static let bridgeTokenHeader = HTTPField.Name(BridgeSecurity.bridgeTokenHeader)!

    func testSessionCRUDReloadsMaskedStateWithoutExposingValue() async throws {
        let fixture = InMemoryPersistedSecrets()
        let sessionStore = SessionSecretStore()
        let injector = SecretInjector(
            sessionId: "session-route-fixture",
            persistedStore: fixture.access,
            sessionStore: sessionStore
        )
        try await withApp(injector: injector) { client in
            let firstValue = "first-session-fixture-value"
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","value":"first-session-fixture-value"}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
            let initialRecord = await sessionStore.getRecord(name: "TOKEN")
            XCTAssertEqual(initialRecord?.domains, [])

            let replacementValue = "replacement-session-fixture"
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(
                    string: #"{"name":"TOKEN","value":"replacement-session-fixture","domains":["api.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }

            try await client.execute(uri: "/api/secrets/session", method: .get) { response in
                XCTAssertEqual(response.status, .ok)
                let text = String(buffer: response.body)
                XCTAssertFalse(text.contains(firstValue))
                XCTAssertFalse(text.contains(replacementValue))
                let entries = try self.decodeJSONArray(response.body)
                XCTAssertEqual(entries.count, 1)
                guard case .object(let entry) = entries[0] else { return XCTFail("Expected object") }
                XCTAssertEqual(entry["name"]?.stringValue, "TOKEN")
                XCTAssertNil(entry["value"])
            }

            try await client.execute(uri: "/api/secrets/masked", method: .get) { response in
                let text = String(buffer: response.body)
                XCTAssertEqual(response.status, .ok)
                XCTAssertFalse(text.contains(replacementValue))
                XCTAssertTrue(text.contains("maskedValue"))
            }

            try await client.execute(uri: "/api/secrets/peek?name=TOKEN", method: .get) { response in
                XCTAssertEqual(response.status, .ok)
                let object = try self.decodeJSONObject(response.body)
                XCTAssertEqual(object["preview"]?.stringValue, previewSecret(replacementValue))
                XCTAssertNotEqual(object["preview"]?.stringValue, replacementValue)
                XCTAssertNil(object["value"])
            }

            try await client.execute(
                uri: "/api/secrets/scope",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","domains":["updated.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
            let scopedRecord = await sessionStore.getRecord(name: "TOKEN")
            XCTAssertEqual(scopedRecord?.domains, ["updated.example"])

            try await client.execute(uri: "/api/secrets/TOKEN", method: .delete) { response in
                XCTAssertEqual(response.status, .ok)
                let object = try self.decodeJSONObject(response.body)
                XCTAssertEqual(object["fromSession"], .bool(true))
            }
            let deletedRecord = await sessionStore.getRecord(name: "TOKEN")
            XCTAssertNil(deletedRecord)
            XCTAssertNil(injector.maskedValue(for: "TOKEN"))
        }
    }

    func testValidationAndUnknownResponses() async throws {
        let fixture = InMemoryPersistedSecrets()
        let injector = SecretInjector(sessionId: "session-validation-fixture", persistedStore: fixture.access)
        try await withApp(injector: injector) { client in
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","domains":"invalid"}"#)
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
            }
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","value":"fixture-value","domains":null}"#)
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
            }
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","value":"fixture-value"}"#)
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
            }
            try await client.execute(uri: "/api/secrets/peek", method: .get) { response in
                XCTAssertEqual(response.status, .badRequest)
            }
            try await client.execute(uri: "/api/secrets/peek?name=UNKNOWN", method: .get) { response in
                XCTAssertEqual(response.status, .notFound)
            }
            try await client.execute(
                uri: "/api/secrets/scope",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"UNKNOWN","domains":[]}"#)
            ) { response in
                XCTAssertEqual(response.status, .notFound)
            }
        }
    }

    /// The persisted set writes through whatever `SecretStoreAccess` is
    /// injected — the Keychain in production, this fixture under test — and
    /// reloads masking so the new secret is usable without a restart. A session
    /// record of the same name still shadows it for peek/delete (asserted by
    /// `testSessionDeleteWinsCollisionThenRevealsPersistedMask`).
    func testPersistedSetWritesThroughInjectedStore() async throws {
        let fixture = InMemoryPersistedSecrets()
        let injector = SecretInjector(sessionId: "persisted-set-store-fixture", persistedStore: fixture.access)
        try await withApp(injector: injector) { client in
            let value = "persisted-store-fixture-value"
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"TOKEN","value":"\#(value)","domains":["api.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(try self.decodeJSONObject(response.body)["ok"], .bool(true))
            }
            XCTAssertEqual(fixture.get(name: "TOKEN"), Secret(name: "TOKEN", value: value, domains: ["api.example"]))

            try await client.execute(uri: "/api/secrets", method: .get) { response in
                XCTAssertEqual(response.status, .ok)
                let entries = try self.decodeJSONArray(response.body)
                XCTAssertEqual(entries.count, 1)
                guard case .object(let entry) = entries[0] else { return XCTFail("Expected object") }
                XCTAssertEqual(entry["name"]?.stringValue, "TOKEN")
                XCTAssertEqual(entry["domains"], .array([.string("api.example")]))
                XCTAssertNil(entry["value"], "Secret value must never be returned")
            }

            try await client.execute(uri: "/api/secrets/masked", method: .get) { response in
                XCTAssertEqual(response.status, .ok)
                let text = String(buffer: response.body)
                XCTAssertTrue(text.contains("TOKEN"))
                XCTAssertFalse(text.contains(value))
            }
        }
    }

    /// A `--env-file` entry is re-applied over the persisted store on every
    /// reload, so a persisted write to a shadowed name could never take effect.
    /// Refuse it instead of returning a 200 that leaves the OLD credential in
    /// use. node-server cannot reach this state — there `--env-file` IS the
    /// persisted store's backing file — so this rejection never fires on a
    /// request node would have accepted.
    func testPersistedSetRefusesNameShadowedByEnvFile() async throws {
        let fixture = InMemoryPersistedSecrets()
        let injector = SecretInjector(
            sessionId: "persisted-set-envfile-fixture",
            envFileSecrets: [Secret(name: "SHADOWED", value: "env-file-fixture-value", domains: ["env.example"])],
            persistedStore: fixture.access
        )
        try await withApp(injector: injector) { client in
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"SHADOWED","value":"api-fixture-value","domains":["api.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .conflict)
                let text = String(buffer: response.body)
                XCTAssertTrue(text.contains("--env-file"))
                XCTAssertFalse(text.contains("env-file-fixture-value"))
                XCTAssertFalse(text.contains("api-fixture-value"))
            }
            XCTAssertNil(fixture.get(name: "SHADOWED"), "A shadowed write must not reach the persisted store")
            // The env-file value is still the one the pipeline serves.
            try await client.execute(uri: "/api/secrets/peek?name=SHADOWED", method: .get) { response in
                XCTAssertEqual(response.status, .notFound)
            }
        }

        // An unshadowed name on the same injector still writes normally.
        let injector2 = SecretInjector(
            sessionId: "persisted-set-envfile-fixture-2",
            envFileSecrets: [Secret(name: "SHADOWED", value: "env-file-fixture-value", domains: ["env.example"])],
            persistedStore: fixture.access
        )
        try await withApp(injector: injector2) { client in
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"UNSHADOWED","value":"api-fixture-value","domains":["api.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
        }
        XCTAssertEqual(fixture.get(name: "UNSHADOWED")?.domains, ["api.example"])
    }

    func testSessionDeleteWinsCollisionThenRevealsPersistedMask() async throws {
        let fixture = InMemoryPersistedSecrets([
            Secret(name: "TOKEN", value: "persisted-fixture-value", domains: ["persisted.example"])
        ])
        let sessionStore = SessionSecretStore()
        await sessionStore.set(name: "TOKEN", value: "session-fixture-value", domains: ["session.example"])
        let injector = SecretInjector(
            sessionId: "session-collision-fixture",
            persistedStore: fixture.access,
            sessionStore: sessionStore
        )
        await injector.reload()
        let persistedMask = try XCTUnwrap(injector.maskedValue(for: "TOKEN"))

        try await withApp(injector: injector) { client in
            try await client.execute(uri: "/api/secrets/TOKEN", method: .delete) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(try self.decodeJSONObject(response.body)["fromSession"], .bool(true))
            }
        }

        XCTAssertNotNil(fixture.get(name: "TOKEN"))
        XCTAssertEqual(injector.maskedValue(for: "TOKEN"), persistedMask)
    }

    func testPeekScopeAndDeleteFallBackToInjectedPersistedStore() async throws {
        let value = "persisted-route-fixture-value"
        let fixture = InMemoryPersistedSecrets([
            Secret(name: "SAVED", value: value, domains: ["old.example"])
        ])
        let injector = SecretInjector(sessionId: "persisted-fallback-fixture", persistedStore: fixture.access)

        try await withApp(injector: injector) { client in
            try await client.execute(uri: "/api/secrets/peek?name=SAVED", method: .get) { response in
                XCTAssertEqual(response.status, .ok)
                let object = try self.decodeJSONObject(response.body)
                XCTAssertEqual(object["preview"]?.stringValue, previewSecret(value))
                XCTAssertNil(object["value"])
            }
            try await client.execute(
                uri: "/api/secrets/scope",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"SAVED","domains":["new.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
            XCTAssertEqual(fixture.get(name: "SAVED")?.domains, ["new.example"])
            try await client.execute(uri: "/api/secrets/SAVED", method: .delete) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(try self.decodeJSONObject(response.body)["fromSession"], .bool(false))
            }
        }

        XCTAssertNil(fixture.get(name: "SAVED"))
    }

    /// A scope edit re-saves the existing value, so it is a second path that
    /// could write a multiline value into the line-oriented blob. It refuses
    /// with the same named 400 as the set route and leaves the record's domains
    /// untouched (#2828). node-server's `handleScopeEdit` mirrors this.
    func testScopeRefusesToReSaveAMultilinePersistedValue() async throws {
        let fixture = InMemoryPersistedSecrets([
            Secret(name: "PEM", value: "-----BEGIN KEY-----\nbody\n-----END KEY-----", domains: ["old.example"])
        ])
        let injector = SecretInjector(sessionId: "scope-multiline-fixture", persistedStore: fixture.access)

        try await withApp(injector: injector) { client in
            try await client.execute(
                uri: "/api/secrets/scope",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"PEM","domains":["new.example"]}"#)
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(response.body)["error"]?.stringValue,
                    EnvFileFormat.multilineValueError("PEM")
                )
            }
        }

        XCTAssertEqual(fixture.get(name: "PEM")?.domains, ["old.example"])
    }

    func testSessionRoutesKeepThinBridgeCorsAndTokenGate() async throws {
        let fixture = InMemoryPersistedSecrets()
        let injector = SecretInjector(sessionId: "session-cors-fixture", persistedStore: fixture.access)
        try await withApp(injector: injector, bridgeToken: "fixture-token") { client in
            try await client.execute(
                uri: "/api/secrets/session",
                method: .options,
                headers: [.origin: "https://www.sliccy.ai"]
            ) { response in
                XCTAssertEqual(response.status, .noContent)
                XCTAssertEqual(response.headers[Self.allowOrigin], "https://www.sliccy.ai")
            }
            let body = ByteBuffer(string: #"{"name":"TOKEN","value":"cors-fixture-value","domains":["api.example"]}"#)
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.origin: "https://www.sliccy.ai", .contentType: "application/json"],
                body: body
            ) { response in
                XCTAssertEqual(response.status, .forbidden)
                XCTAssertEqual(response.headers[Self.allowOrigin], "https://www.sliccy.ai")
            }
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [
                    .origin: "https://www.sliccy.ai",
                    .contentType: "application/json",
                    Self.bridgeTokenHeader: "fixture-token",
                ],
                body: body
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(response.headers[Self.allowOrigin], "https://www.sliccy.ai")
            }
            // The persisted write is the most privileged secret route, so pin
            // that it sits behind the same token gate rather than assuming the
            // `/api/*` prefix match covers it.
            let persistedBody = ByteBuffer(
                string: #"{"name":"PERSISTED","value":"cors-fixture-value","domains":["api.example"]}"#)
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [.origin: "https://www.sliccy.ai", .contentType: "application/json"],
                body: persistedBody
            ) { response in
                XCTAssertEqual(response.status, .forbidden)
                XCTAssertEqual(response.headers[Self.allowOrigin], "https://www.sliccy.ai")
            }
            XCTAssertNil(fixture.get(name: "PERSISTED"), "A token-gated rejection must not reach the store")
            try await client.execute(
                uri: "/api/secrets",
                method: .post,
                headers: [
                    .origin: "https://www.sliccy.ai",
                    .contentType: "application/json",
                    Self.bridgeTokenHeader: "fixture-token",
                ],
                body: persistedBody
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
            XCTAssertEqual(fixture.get(name: "PERSISTED")?.domains, ["api.example"])
        }
    }

    private func withApp(
        injector: SecretInjector,
        bridgeToken: String? = nil,
        _ body: (any TestClientProtocol) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            let router = Router(context: BasicRequestContext.self)
            if let bridgeToken {
                router.middlewares.add(ThinBridgeCorsMiddleware<BasicRequestContext>(bridgeToken: bridgeToken))
            }
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await body(client)
            }
            try await httpClient.shutdown()
        } catch {
            try? await httpClient.shutdown()
            throw error
        }
    }

    private func decodeJSONObject(_ body: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: body).utf8))
    }

    private func decodeJSONArray(_ body: ByteBuffer) throws -> [LickSystem.JSONValue] {
        try JSONDecoder().decode([LickSystem.JSONValue].self, from: Data(String(buffer: body).utf8))
    }

    private func makeConfig() -> ServerConfig {
        .init(
            serveOnly: false, cdpPort: 9222, explicitCdpPort: false, electron: false,
            electronApp: nil, electronAppURL: nil, kill: false, lead: false,
            leadWorkerBaseUrl: nil, leadWorkerBaseURL: nil, profile: nil,
            join: false, joinUrl: nil, joinURL: nil, logLevel: "info",
            logDir: nil, logDirectoryURL: nil, prompt: nil, envFile: nil, envFileURL: nil
        )
    }
}

private final class InMemoryPersistedSecrets: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: Secret]

    init(_ secrets: [Secret] = []) {
        self.entries = Dictionary(uniqueKeysWithValues: secrets.map { ($0.name, $0) })
    }

    var access: SecretStoreAccess {
        SecretStoreAccess(
            loadAll: { self.all() },
            save: { name, value, domains in self.set(name: name, value: value, domains: domains) },
            remove: { name in self.delete(name: name) }
        )
    }

    func get(name: String) -> Secret? {
        lock.lock()
        defer { lock.unlock() }
        return entries[name]
    }

    private func all() -> [Secret] {
        lock.lock()
        defer { lock.unlock() }
        return Array(entries.values)
    }

    private func set(name: String, value: String, domains: [String]) {
        lock.lock()
        defer { lock.unlock() }
        entries[name] = Secret(name: name, value: value, domains: domains)
    }

    private func delete(name: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: name)
    }
}
