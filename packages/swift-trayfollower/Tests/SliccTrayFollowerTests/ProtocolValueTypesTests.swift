import Foundation
import XCTest

@testable import SliccTrayFollower

/// The small value structs, enums, and module globals that back the message
/// unions: identity accessors, optional-field defaults, and the advertised
/// capabilities / protocol version.
final class ProtocolValueTypesTests: XCTestCase {

    // MARK: - Globals

    func testProtocolVersionMatchesSharedTs() {
        XCTAssertEqual(traySyncProtocolVersion, 8)
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
        XCTAssertNil(scoop.parentId)
    }

    /// #2358: a leader that saw us announce protocol version 8 stops sending
    /// `isCone`. The summary must still DECODE — a required `Bool` here would
    /// fail the whole `scoops.list` and cost the app its entire roster.
    func testScoopSummaryDecodesWithoutIsCone() throws {
        let decoder = JSONDecoder()
        let root = try decoder.decode(
            ScoopSummary.self,
            from: Data(
                #"{"jid":"c","name":"Cone","folder":"cone","assistantLabel":"sliccy","parentId":null}"#
                    .utf8))
        XCTAssertNil(root.isCone)
        XCTAssertNil(root.parentId)

        let child = try decoder.decode(
            ScoopSummary.self,
            from: Data(
                #"{"jid":"s","name":"reviewer","folder":"/scoops/reviewer","assistantLabel":"Reviewer","parentId":"c"}"#
                    .utf8))
        XCTAssertNil(child.isCone)
        XCTAssertEqual(child.parentId, "c")

        // The whole envelope, which is what actually reaches the app.
        let list = try decoder.decode(
            LeaderToFollowerMessage.self,
            from: Data(
                #"{"type":"scoops.list","scoops":[{"jid":"c","name":"Cone","folder":"cone","assistantLabel":"sliccy","parentId":null}],"activeScoopJid":"c"}"#
                    .utf8))
        guard case .scoopsList(let scoops, let active) = list else {
            return XCTFail("expected scoops.list, got \(list)")
        }
        XCTAssertEqual(active, "c")
        XCTAssertEqual(scoops.count, 1)
        XCTAssertNil(scoops[0].isCone)
    }

    /// #1666 / #2270: the ownership edge rides the wire next to the derived
    /// `isCone` flag. A scoop carries its cone's jid; a cone carries `null`;
    /// a leader that predates the field sends nothing — all three decode.
    func testScoopSummaryParentIdRoundTripAndLegacyDecode() throws {
        let scoop = ScoopSummary(
            jid: "s1", name: "reviewer", folder: "/scoops/reviewer", isCone: false,
            assistantLabel: "Reviewer", parentId: "cone")
        XCTAssertEqual(try WireCodec.roundTrip(scoop), scoop)
        XCTAssertEqual(try WireCodec.roundTrip(scoop).parentId, "cone")

        let decoder = JSONDecoder()
        let explicitNull = Data(
            #"{"jid":"c","name":"Cone","folder":"cone","isCone":true,"assistantLabel":"sliccy","parentId":null}"#
                .utf8)
        let cone = try decoder.decode(ScoopSummary.self, from: explicitNull)
        XCTAssertEqual(cone.isCone, true)
        XCTAssertNil(cone.parentId)

        let legacy = Data(
            #"{"jid":"s","name":"old","folder":"/scoops/old","isCone":false,"assistantLabel":"old"}"#.utf8)
        let old = try decoder.decode(ScoopSummary.self, from: legacy)
        XCTAssertEqual(old.isCone, false)
        XCTAssertNil(old.parentId)
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
