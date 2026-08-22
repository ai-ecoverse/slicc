import Foundation
import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

final class ModelProtocolTests: XCTestCase {
    func testCatalogCarriesOnlyCredentialFreeMetadata() throws {
        let message = LeaderToFollowerMessage.modelsList(models: [
            TrayModelCatalogEntry(
                providerName: "Example", modelId: "example:reasoner",
                modelName: "Reasoner", reasoning: true)
        ])
        let data = try JSONEncoder().encode(message)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let models = try XCTUnwrap(object["models"] as? [[String: Any]])
        XCTAssertEqual(
            Set(models[0].keys),
            Set(["providerName", "modelId", "modelName", "reasoning"]))
    }

    @MainActor
    func testMaxThinkingUsesXHighWithEffortOverride() throws {
        let wireValue = try XCTUnwrap(AppState.thinkingWireValue(for: "max"))
        XCTAssertEqual(wireValue.level, .xhigh)
        XCTAssertEqual(wireValue.effortOverride, "max")

        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.thinkingSet(
                scoopJid: "cone", thinkingLevel: wireValue.level,
                effortOverride: wireValue.effortOverride))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "thinking.set")
        XCTAssertEqual(object["scoopJid"] as? String, "cone")
        XCTAssertEqual(object["thinkingLevel"] as? String, "xhigh")
        XCTAssertEqual(object["effortOverride"] as? String, "max")
    }

    /// Model selection is PER CONE (#2310): the pick names the unit this
    /// follower is viewing, so the leader changes that cone's record and not
    /// whichever cone it happens to have selected itself.
    func testModelSelectionNamesTheViewedConeOnTheWire() throws {
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.modelSelect(modelId: "example:reasoner", scoopJid: "cone_2"))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "model.select")
        XCTAssertEqual(object["modelId"] as? String, "example:reasoner")
        XCTAssertEqual(object["scoopJid"] as? String, "cone_2")
    }

    /// With nothing selected the key is omitted entirely, and the leader falls
    /// back to this follower's own `scoops.select`.
    func testModelSelectionOmitsTheUnitWhenNoneIsSelected() throws {
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.modelSelect(modelId: "example:reasoner", scoopJid: nil))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["scoopJid"])
    }

    @MainActor
    func testAppStateAcceptsModelMessagesOnlyAfterV5Hello() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        let catalog = LeaderToFollowerMessage.modelsList(models: [
            TrayModelCatalogEntry(
                providerName: "Example", modelId: "example:reasoner",
                modelName: "Reasoner", reasoning: true)
        ])
        let catalogData = try JSONEncoder().encode(catalog)

        state.handleDataChannelMessage(catalogData)
        XCTAssertTrue(state.modelCatalog.isEmpty)

        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.hello(
                    protocolVersion: 5, runtime: "leader", capabilities: nil, motd: nil)))
        state.handleDataChannelMessage(catalogData)
        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.modelState(
                    state: TrayModelSelectionState(
                        activeModelId: "example:reasoner", scoopJid: "cone",
                        thinkingLevel: .xhigh, effortOverride: "max"))))

        XCTAssertEqual(state.activeModel?.modelName, "Reasoner")
        XCTAssertEqual(state.displayedThinkingLevel, "max")
    }

    @MainActor
    func testMinimalThinkingDisplaysAsLowLikeTheBrowserFollower() throws {
        let state = AppState()
        state.selectedScoopJid = "scoop-a"
        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.hello(
                    protocolVersion: 5, runtime: "leader", capabilities: nil, motd: nil)))
        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.modelState(
                    state: TrayModelSelectionState(
                        activeModelId: "example:reasoner", scoopJid: "scoop-a",
                        thinkingLevel: .minimal, effortOverride: nil))))
        XCTAssertEqual(state.displayedThinkingLevel, "low")
    }

    @MainActor
    func testReconnectSnapshotRequestPreservesViewedScoop() throws {
        let state = AppState()
        state.selectedScoopJid = "research"

        let data = try JSONEncoder().encode(state.snapshotRequestForConnection())
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "request_snapshot")
        XCTAssertEqual(object["scoopJid"] as? String, "research")
    }

    @MainActor
    func testMissingPreservedScoopFallsBackToActive() throws {
        let state = AppState()
        state.selectedScoopJid = "removed-scoop"
        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.scoopsList(
                    scoops: [
                        ScoopSummary(
                            jid: "cone", name: "cone", folder: "/workspace", isCone: true,
                            assistantLabel: "sliccy", trigger: nil, state: nil, fill: nil),
                        ScoopSummary(
                            jid: "active", name: "active", folder: "/scoops/active",
                            isCone: false, assistantLabel: "active", trigger: nil, state: nil,
                            fill: nil),
                    ], activeScoopJid: "active")))

        XCTAssertEqual(state.selectedScoopJid, "active")
    }
}
