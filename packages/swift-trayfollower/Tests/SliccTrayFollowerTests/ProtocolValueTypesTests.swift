import Foundation
import XCTest

@testable import SliccTrayFollower

/// The small value structs, enums, and module globals that back the message
/// unions: identity accessors, optional-field defaults, and the advertised
/// capabilities / protocol version.
final class ProtocolValueTypesTests: XCTestCase {

    // MARK: - Globals

    func testProtocolVersionMatchesSharedTs() {
        XCTAssertEqual(traySyncProtocolVersion, 7)
    }

    func testAdvertisedFollowerCapabilities() {
        XCTAssertTrue(trayFollowerCapabilities.exec)
        XCTAssertEqual(trayFollowerCapabilities.browser, true)
        XCTAssertNil(trayFollowerCapabilities.oauthPopup)
        // v7 (#2062): every iOS build renders delegated sudo prompts; only a
        // device that can authenticate its owner claims `biometric`.
        XCTAssertEqual(trayFollowerCapabilities.sudoApproval, true)
        XCTAssertNil(trayFollowerCapabilities.biometric)
        XCTAssertEqual(makeTrayFollowerCapabilities(deviceOwnerAuth: true).biometric, true)
    }

    // MARK: - Enums

    func testNewSessionActionRawValues() throws {
        XCTAssertEqual(NewSessionAction.save.rawValue, "save")
        XCTAssertEqual(NewSessionAction.skip.rawValue, "skip")
        XCTAssertEqual(NewSessionAction.erase.rawValue, "erase")
        for action in [NewSessionAction.save, .skip, .erase] {
            XCTAssertEqual(try WireCodec.roundTrip(action), action)
        }
    }

    func testThinkingLevelCasesAndRawValues() throws {
        XCTAssertEqual(TrayThinkingLevel.allCases, [.off, .minimal, .low, .medium, .high, .xhigh])
        for level in TrayThinkingLevel.allCases {
            XCTAssertEqual(try WireCodec.roundTrip(level), level)
        }
    }

    // MARK: - ScoopSummary

    func testScoopSummaryFullRoundTripAndIdentity() throws {
        let scoop = ScoopSummary(
            jid: "j1", name: "Cone", folder: "/root", isCone: true, assistantLabel: "Assistant",
            trigger: "manual", state: "active", fill: 55.0)
        XCTAssertEqual(scoop.id, "j1")
        XCTAssertEqual(try WireCodec.roundTrip(scoop), scoop)
    }

    func testScoopSummaryOptionalDefaults() {
        let scoop = ScoopSummary(jid: "j1", name: "n", folder: "/", isCone: false, assistantLabel: "A")
        XCTAssertNil(scoop.trigger)
        XCTAssertNil(scoop.state)
        XCTAssertNil(scoop.fill)
    }

    // MARK: - SprinkleSummary

    func testSprinkleSummaryIdentityAndDefaults() {
        let sprinkle = SprinkleSummary(name: "n", title: "T", path: "/p", open: false)
        XCTAssertEqual(sprinkle.id, "n")
        XCTAssertFalse(sprinkle.autoOpen)
        XCTAssertNil(sprinkle.icon)
    }

    func testSprinkleSummaryRoundTrip() throws {
        let sprinkle = SprinkleSummary(name: "n", title: "T", path: "/p", open: true, autoOpen: true, icon: "data:image/svg+xml,...")
        XCTAssertEqual(try WireCodec.roundTrip(sprinkle), sprinkle)
    }

    // MARK: - Model catalog / selection

    func testModelCatalogEntryIdentityAndRoundTrip() throws {
        let entry = TrayModelCatalogEntry(providerName: "anthropic", modelId: "claude-x", modelName: "Claude X", reasoning: true)
        XCTAssertEqual(entry.id, "claude-x")
        XCTAssertEqual(try WireCodec.roundTrip(entry), entry)
    }

    func testModelSelectionStateRoundTrip() throws {
        let state = TrayModelSelectionState(activeModelId: "claude-x", scoopJid: "j1", thinkingLevel: .medium, effortOverride: nil)
        XCTAssertEqual(try WireCodec.roundTrip(state), state)
    }

    // MARK: - Capabilities

    func testCherryCapabilitiesRoundTrip() throws {
        let caps = CherryCapabilities(navigate: true, network: false, screenshot: true)
        XCTAssertEqual(try WireCodec.roundTrip(caps), caps)
    }

    func testTraySyncCapabilitiesOmitsNilOptionals() throws {
        let json = try WireCodec.jsonString(TraySyncCapabilities(exec: true))
        XCTAssertTrue(json.contains("\"exec\":true"))
        XCTAssertFalse(json.contains("browser"))
        XCTAssertFalse(json.contains("oauthPopup"))
    }

    func testTraySyncCapabilitiesRoundTrip() throws {
        let caps = TraySyncCapabilities(exec: false, browser: true, oauthPopup: false)
        XCTAssertEqual(try WireCodec.roundTrip(caps), caps)
    }

    // MARK: - Targets

    func testRemoteTargetInfoOptionalDefaults() {
        let target = RemoteTargetInfo(targetId: "t1", title: "Tab", url: "https://x")
        XCTAssertNil(target.kind)
        XCTAssertNil(target.capabilities)
    }

    func testRemoteTargetInfoRoundTrip() throws {
        let target = RemoteTargetInfo(
            targetId: "t1", title: "Tab", url: "https://x", kind: "cherry",
            capabilities: CherryCapabilities(navigate: false, network: true, screenshot: false))
        XCTAssertEqual(try WireCodec.roundTrip(target), target)
    }

    func testTrayTargetEntryRoundTrip() throws {
        let entry = TrayTargetEntry(
            targetId: "t1", localTargetId: "l1", runtimeId: "r1", title: "Tab", url: "https://x", isLocal: false)
        XCTAssertNil(entry.kind)
        XCTAssertNil(entry.capabilities)
        XCTAssertEqual(try WireCodec.roundTrip(entry), entry)
    }

    // MARK: - CDPTargetSummary (local-only, not on the wire)

    func testCdpTargetSummaryEqualityAndIdentity() {
        let a = CDPTargetSummary(id: "t1", title: "Tab", url: "https://x")
        let b = CDPTargetSummary(id: "t1", title: "Tab", url: "https://x")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.id, "t1")
        XCTAssertNotEqual(a, CDPTargetSummary(id: "t2", title: "Tab", url: "https://x"))
    }
}
