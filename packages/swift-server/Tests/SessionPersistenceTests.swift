import XCTest
@testable import slicc_server

final class SessionPersistenceTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
        tmpDir = base.appendingPathComponent("slicc-session-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    private var sessionIdPath: URL {
        tmpDir.appendingPathComponent("session-id")
    }

    func testGeneratesUUIDAndWritesFileWith0600WhenMissing() throws {
        let id = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sessionIdPath.path))

        let raw = try String(contentsOf: sessionIdPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(raw, id)

        // POSIX mode parity with node-server's chmodSync(path, 0o600).
        let attrs = try FileManager.default.attributesOfItem(atPath: sessionIdPath.path)
        if let posix = attrs[.posixPermissions] as? NSNumber {
            XCTAssertEqual(posix.int16Value & 0o777, 0o600)
        }
    }

    func testReusesExistingUUIDAcrossCalls() throws {
        let a = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        let b = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        XCTAssertEqual(a, b)
    }

    func testOverwritesEmptyFile() throws {
        try "   \n".data(using: .utf8)!.write(to: sessionIdPath, options: .atomic)
        let id = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        XCTAssertNotNil(UUID(uuidString: id))
        let raw = try String(contentsOf: sessionIdPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(raw, id)
    }

    func testOverwritesCorruptNonUUIDFile() throws {
        try "not-a-valid-uuid\n".data(using: .utf8)!.write(to: sessionIdPath, options: .atomic)
        let id = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        XCTAssertNotNil(UUID(uuidString: id))
        let raw = try String(contentsOf: sessionIdPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(raw, id)
        XCTAssertNotEqual(raw, "not-a-valid-uuid")
    }

    /// Tripwire: two SecretInjector instances built off the same on-disk
    /// session-id must produce identical masks for the same (name, value).
    /// Mirrors `mask round-trip across SecretProxyManager re-instantiations`
    /// from packages/node-server/tests/secrets/session-persistence.test.ts.
    func testMaskRoundTripAcrossInjectorReinstantiations() async throws {
        let sid1 = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        let sid2 = try SecretInjector.readOrCreateSessionId(in: tmpDir)
        XCTAssertEqual(sid1, sid2)

        let envSecret = Secret(
            name: "TRIPWIRE_SESSION_\(UUID().uuidString.prefix(8))",
            value: "ghp_real",
            domains: ["api.github.com"]
        )
        let a = SecretInjector(sessionId: sid1, envFileSecrets: [envSecret])
        await a.reload()
        let b = SecretInjector(sessionId: sid2, envFileSecrets: [envSecret])
        await b.reload()
        let maskedA = a.maskedValue(for: envSecret.name)
        let maskedB = b.maskedValue(for: envSecret.name)
        XCTAssertNotNil(maskedA)
        XCTAssertEqual(maskedA, maskedB)
    }
}
