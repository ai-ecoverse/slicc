import Foundation
import XCTest

@testable import SliccTrayFollower




final class ProtocolValueTypesTests: XCTestCase {

    

    func testProtocolVersionMatchesSharedTs() {
        XCTAssertEqual(traySyncProtocolVersion, 8)
    }

    func testAdvertisedFollowerCapabilities() {
        XCTAssertTrue(trayFollowerCapabilities.exec)
        XCTAssertEqual(trayFollowerCapabilities.browser, true)
        XCTAssertNil(trayFollowerCapabilities.oauthPopup)
        
        
        XCTAssertEqual(trayFollowerCapabilities.sudoApproval, true)
        XCTAssertNil(trayFollowerCapabilities.biometric)
        XCTAssertEqual(makeTrayFollowerCapabilities(deviceOwnerAuth: true).biometric, true)
        
        XCTAssertNil(trayFollowerCapabilities.computer)
        XCTAssertNil(makeTrayFollowerCapabilities(deviceOwnerAuth: true).computer)
    }

    

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

    

    func testModelCatalogEntryIdentityAndRoundTrip() throws {
        let entry = TrayModelCatalogEntry(providerName: "anthropic", modelId: "claude-x", modelName: "Claude X", reasoning: true)
        XCTAssertEqual(entry.id, "claude-x")
        XCTAssertEqual(try WireCodec.roundTrip(entry), entry)
    }

    func testModelSelectionStateRoundTrip() throws {
        let state = TrayModelSelectionState(activeModelId: "claude-x", scoopJid: "j1", thinkingLevel: .medium, effortOverride: nil)
        XCTAssertEqual(try WireCodec.roundTrip(state), state)
    }

    

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

    func testTraySyncCapabilitiesComputerFlagRoundTrip() throws {
        let caps = TraySyncCapabilities(exec: true, computer: true)
        XCTAssertEqual(try WireCodec.roundTrip(caps).computer, true)
        let json = try WireCodec.jsonString(caps)
        XCTAssertTrue(json.contains("\"computer\":true"))
    }

    

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

    

    func testCdpTargetSummaryEqualityAndIdentity() {
        let a = CDPTargetSummary(id: "t1", title: "Tab", url: "https://x")
        let b = CDPTargetSummary(id: "t1", title: "Tab", url: "https://x")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.id, "t1")
        XCTAssertNotEqual(a, CDPTargetSummary(id: "t2", title: "Tab", url: "https://x"))
    }
}
