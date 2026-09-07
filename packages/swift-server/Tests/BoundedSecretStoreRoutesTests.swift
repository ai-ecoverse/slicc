import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import XCTest

@testable import slicc_server

/// Regression cover for the hung `secret list`: a persisted store that does not
/// answer (in production, `SecItemCopyMatching` sitting on an unanswered
/// Keychain ACL dialog) must not wedge the request path.
final class BoundedSecretStoreRoutesTests: XCTestCase {
    func testListReportsADiagnosisInsteadOfHangingOnAStalledStore() async throws {
        let fixture = StallingPersistedSecrets([Secret(name: "SAVED_TOKEN", value: "saved-value", domains: [])])
        let injector = SecretInjector(
            sessionId: "bounded-list-fixture",
            persistedStore: fixture.access,
            sessionStore: SessionSecretStore()
        )
        try await withApp(injector: injector) { client in
            fixture.stall = true

            let clock = ContinuousClock()
            let elapsed = try await clock.measure {
                try await client.execute(uri: "/api/secrets", method: .get) { response in
                    XCTAssertEqual(response.status, .serviceUnavailable)
                    let object = try self.decodeJSONObject(response.body)
                    XCTAssertEqual(object["errorCode"]?.stringValue, BoundedStoreCall.timeoutErrorCode)
                    let message = object["error"]?.stringValue ?? ""
                    // The point of the fix: the caller learns what to do, so
                    // assert the actionable parts and not just "some error".
                    XCTAssertTrue(message.contains("Keychain"), message)
                    XCTAssertTrue(message.contains("docs/secrets.md"), message)
                    // An empty list would read as "you have no saved secrets".
                    XCTAssertFalse(message.isEmpty)
                }
            }
            // Answered on its own deadline rather than the store's.
            XCTAssertLessThan(elapsed, .seconds(BoundedStoreCall.defaultTimeoutSeconds + 3))
            XCTAssertGreaterThan(elapsed, .seconds(BoundedStoreCall.defaultTimeoutSeconds - 1))
        }
    }

    /// The routes that read the in-memory snapshot are what `secret get` and
    /// `printenv` use, and they stayed fast even while `list` hung — keep it so.
    func testSnapshotAndSessionRoutesStayFastWhileTheStoreIsStalled() async throws {
        let fixture = StallingPersistedSecrets()
        let sessionStore = SessionSecretStore()
        let injector = SecretInjector(
            sessionId: "bounded-snapshot-fixture",
            persistedStore: fixture.access,
            sessionStore: sessionStore
        )
        try await withApp(injector: injector) { client in
            try await client.execute(
                uri: "/api/secrets/session",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: #"{"name":"SESSION_TOKEN","value":"session-fixture-value"}"#)
            ) { XCTAssertEqual($0.status, .ok) }

            fixture.stall = true
            let clock = ContinuousClock()

            let maskedElapsed = try await clock.measure {
                try await client.execute(uri: "/api/secrets/masked", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertFalse(String(buffer: response.body).contains("session-fixture-value"))
                }
            }
            XCTAssertLessThan(maskedElapsed, .seconds(2))

            // Session secrets are held in memory, so `secret list` can still
            // render its SESSION rows while the saved half is unavailable.
            let sessionElapsed = try await clock.measure {
                try await client.execute(uri: "/api/secrets/session", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertTrue(String(buffer: response.body).contains("SESSION_TOKEN"))
                }
            }
            XCTAssertLessThan(sessionElapsed, .seconds(2))
        }
    }

    func testBoundedCallReturnsPromptResultsUnchanged() async throws {
        let value = await BoundedStoreCall.run { "keychain-answered" }
        XCTAssertEqual(value, "keychain-answered")

        let thrown = await BoundedStoreCall.runThrowing { throw StoreProbeError.boom }
        guard case .failure(let error)? = thrown else {
            return XCTFail("Expected the store error to survive the wrapper")
        }
        XCTAssertTrue(error is StoreProbeError)
    }

    func testBoundedCallGivesUpOnAStalledCall() async throws {
        let released = DispatchSemaphore(value: 0)
        let result = await BoundedStoreCall.run(timeoutSeconds: 0.2) {
            released.wait()
            return "too-late"
        }
        XCTAssertNil(result, "A call past its deadline must not be waited for")
        released.signal()
    }

    private func withApp(
        injector: SecretInjector,
        _ body: (any TestClientProtocol) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            let router = Router(context: BasicRequestContext.self)
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

private enum StoreProbeError: Error { case boom }

/// Persisted store whose reads and writes can be made to hang on demand, the way
/// an ungranted Keychain ACL hangs them. Starts responsive so the injector's own
/// startup load stays fast; flip `stall` once the app is up.
private final class StallingPersistedSecrets: @unchecked Sendable {
    /// Comfortably past the wrapper's deadline, yet short enough that the
    /// abandoned thread is reclaimed before the suite finishes.
    private static let stallSeconds: TimeInterval = 10

    private let lock = NSLock()
    private var entries: [String: Secret]
    private var stalling = false

    init(_ secrets: [Secret] = []) {
        self.entries = Dictionary(uniqueKeysWithValues: secrets.map { ($0.name, $0) })
    }

    var stall: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stalling
        }
        set {
            lock.lock()
            stalling = newValue
            lock.unlock()
        }
    }

    var access: SecretStoreAccess {
        SecretStoreAccess(
            loadAll: {
                self.stallIfRequested()
                return self.all()
            },
            save: { name, value, domains in
                self.stallIfRequested()
                self.set(name: name, value: value, domains: domains)
            },
            remove: { name in
                self.stallIfRequested()
                self.delete(name: name)
            }
        )
    }

    private func stallIfRequested() {
        guard stall else { return }
        Thread.sleep(forTimeInterval: Self.stallSeconds)
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
