import SliccTraySession
import XCTest

@testable import Sliccstart

/// Pure-logic coverage for the headless `Sliccstart --list-sessions` path:
/// argument parsing, redacted-vs-full encoding, and the reveal-consent gate.
final class TraySessionCLITests: XCTestCase {

    // MARK: - Argument parsing

    func testParseReturnsNilForNormalLaunch() {
        XCTAssertNil(TraySessionCLI.parse(["/Applications/Sliccstart.app/Contents/MacOS/Sliccstart"]))
        XCTAssertNil(TraySessionCLI.parse(["Sliccstart", "--update-host=https://example.test"]))
    }

    func testParseListSessionsWithoutReveal() {
        let request = TraySessionCLI.parse(["Sliccstart", "--list-sessions"])
        XCTAssertEqual(request, TraySessionCLI.Request(reveal: false))
    }

    func testParseListSessionsWithReveal() {
        let request = TraySessionCLI.parse(["Sliccstart", "--list-sessions", "--reveal-urls"])
        XCTAssertEqual(request, TraySessionCLI.Request(reveal: true))
    }

    func testRevealFlagAloneWithoutListIsNotHeadless() {
        XCTAssertNil(TraySessionCLI.parse(["Sliccstart", "--reveal-urls"]))
    }

    // MARK: - Encoding / redaction

    func testEncodeRedactsJoinURLByDefault() throws {
        let sessions = [makeSession(joinUrl: "https://slicc.test/join/a.secret")]
        let data = try TraySessionCLI.encode(sessions, reveal: false)
        let object = try decodeArray(data)

        XCTAssertEqual(object.count, 1)
        XCTAssertNil(object[0]["joinUrl"], "join URL must never appear without --reveal-urls")
        XCTAssertEqual(object[0]["id"] as? String, sessions[0].id)
        XCTAssertEqual(object[0]["label"] as? String, "Chrome")
        XCTAssertEqual(object[0]["deviceName"] as? String, "MacA")
        let raw = String(data: data, encoding: .utf8) ?? ""
        XCTAssertFalse(raw.contains("secret"))
    }

    func testEncodeIncludesJoinURLWhenRevealed() throws {
        let sessions = [makeSession(joinUrl: "https://slicc.test/join/a.secret")]
        let data = try TraySessionCLI.encode(sessions, reveal: true)
        let object = try decodeArray(data)
        XCTAssertEqual(object[0]["joinUrl"] as? String, "https://slicc.test/join/a.secret")
    }

    func testEncodeUsesISO8601Dates() throws {
        let when = Date(timeIntervalSince1970: 1_700_000_000)
        let sessions = [makeSession(joinUrl: "https://slicc.test/join/a.secret", lastSeenAt: when)]
        let raw = String(data: try TraySessionCLI.encode(sessions, reveal: false), encoding: .utf8) ?? ""
        // ISO-8601 (not a raw Double) so the Go CLI can parse it as RFC3339.
        XCTAssertTrue(raw.contains("2023-11-14T"), "expected ISO-8601 timestamp, got \(raw)")
    }

    func testPayloadMappingPreservesMetadata() {
        let session = makeSession(joinUrl: "https://slicc.test/join/a.secret")
        let dto = TraySessionCLI.payload(from: [session], reveal: false)[0]
        XCTAssertEqual(dto.id, session.id)
        XCTAssertEqual(dto.deviceId, session.deviceId)
        XCTAssertNil(dto.joinUrl)
    }

    // MARK: - Consent outcome

    func testStoredAlwaysDecisionsWinOverGUI() {
        XCTAssertEqual(TraySessionCLI.outcome(stored: .allow, guiAvailable: false), .allow)
        XCTAssertEqual(TraySessionCLI.outcome(stored: .deny, guiAvailable: true), .deny)
    }

    func testNoStoredDecisionPromptsWithGUIAndDeniesHeadless() {
        XCTAssertEqual(TraySessionCLI.outcome(stored: nil, guiAvailable: true), .prompt)
        XCTAssertEqual(TraySessionCLI.outcome(stored: nil, guiAvailable: false), .deny)
    }

    // MARK: - Dialog button mapping

    func testPromptResultMapping() {
        XCTAssertEqual(TraySessionCLI.promptResult(forButtonIndex: 1000), .denyOnce)
        XCTAssertEqual(TraySessionCLI.promptResult(forButtonIndex: 1001), .allowOnce)
        XCTAssertEqual(TraySessionCLI.promptResult(forButtonIndex: 1002), .alwaysAllow)
        XCTAssertEqual(TraySessionCLI.promptResult(forButtonIndex: 1003), .alwaysDeny)
        XCTAssertEqual(TraySessionCLI.promptResult(forButtonIndex: 42), .denyOnce)
    }

    func testEffectOfPromptResult() {
        XCTAssertEqual(TraySessionCLI.effect(of: .allowOnce).allow, true)
        XCTAssertNil(TraySessionCLI.effect(of: .allowOnce).persist)
        XCTAssertEqual(TraySessionCLI.effect(of: .denyOnce).allow, false)
        XCTAssertNil(TraySessionCLI.effect(of: .denyOnce).persist)
        XCTAssertEqual(TraySessionCLI.effect(of: .alwaysAllow).persist, .allow)
        XCTAssertEqual(TraySessionCLI.effect(of: .alwaysDeny).persist, .deny)
        XCTAssertFalse(TraySessionCLI.effect(of: .alwaysDeny).allow)
    }

    // MARK: - Consent key / caller description

    func testConsentKeyPrefersSigningIdentifier() {
        XCTAssertEqual(
            TraySessionCLI.consentKey(signingIdentifier: "com.slicc.slicc-cli", executablePath: "/usr/bin/x"),
            "id:com.slicc.slicc-cli"
        )
        XCTAssertEqual(
            TraySessionCLI.consentKey(signingIdentifier: nil, executablePath: "/usr/local/bin/slicc"),
            "path:/usr/local/bin/slicc"
        )
        XCTAssertEqual(TraySessionCLI.consentKey(signingIdentifier: "", executablePath: ""), "unknown")
    }

    func testDescribeCaller() {
        XCTAssertEqual(
            TraySessionCLI.describeCaller(name: "slicc", pid: 42, signingIdentifier: "com.slicc.slicc-cli"),
            "slicc (pid 42), signed by com.slicc.slicc-cli"
        )
        XCTAssertEqual(
            TraySessionCLI.describeCaller(name: "bash", pid: 7, signingIdentifier: nil),
            "bash (pid 7)"
        )
        XCTAssertEqual(
            TraySessionCLI.describeCaller(name: nil, pid: 9, signingIdentifier: nil),
            "An unidentified process (pid 9)"
        )
    }

    func testDeniedMessageDiffersForHeadless() {
        XCTAssertTrue(TraySessionCLI.deniedMessage(guiAvailable: false).contains("SSH"))
        XCTAssertFalse(TraySessionCLI.deniedMessage(guiAvailable: true).contains("SSH"))
    }

    // MARK: - Persistence

    func testRevealConsentStoreRoundTrip() {
        let suite = "TraySessionCLITests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = RevealConsentStore(defaults: defaults)

        XCTAssertNil(store.load(forConsentKey: "id:x"))
        store.save(.allow, forConsentKey: "id:x")
        XCTAssertEqual(store.load(forConsentKey: "id:x"), .allow)
        store.save(.deny, forConsentKey: "id:x")
        XCTAssertEqual(store.load(forConsentKey: "id:x"), .deny)
        XCTAssertNil(store.load(forConsentKey: "id:other"))
    }

    // MARK: - Helpers

    private func decodeArray(_ data: Data) throws -> [[String: Any]] {
        let json = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(json as? [[String: Any]])
    }

    private func makeSession(
        joinUrl: String,
        lastSeenAt: Date = Date(timeIntervalSince1970: 0)
    ) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: joinUrl,
            label: "Chrome",
            deviceId: "device-A",
            deviceName: "MacA",
            createdAt: lastSeenAt,
            lastSeenAt: lastSeenAt
        )
    }
}
