import SliccTrayKit
import XCTest

@testable import SliccFollower

/// `SliccTabEntity` — the `browser.tab` app-schema projection of the CDP
/// targets Sliccy's browser is hosting.
final class SliccTabEntityTests: XCTestCase {

    private let targets = [
        CDPTargetSummary(id: "t1", title: "SLICC docs", url: "https://sliccy.ai/docs"),
        CDPTargetSummary(id: "t2", title: "", url: "https://example.com/login"),
    ]

    func testEntityMapsTheCDPTargetAndIsNeverPrivate() {
        let entity = SliccTabEntity(target: targets[0])
        XCTAssertEqual(entity.id, "t1")
        XCTAssertEqual(entity.name, "SLICC docs")
        XCTAssertEqual(entity.url?.absoluteString, "https://sliccy.ai/docs")
        // Sliccy's browser has no private mode; the schema property is
        // answered honestly rather than left to a default somewhere else.
        XCTAssertFalse(entity.isPrivate)
    }

    /// A tab that has not painted a title yet is the common case mid-load;
    /// it must not render as a blank row in a Siri disambiguation list.
    func testUntitledTabFallsBackToItsHost() {
        XCTAssertEqual(SliccTabEntity(target: targets[1]).displayLabel, "example.com")
    }

    func testEntityWithNoParsableURLStillRenders() {
        let entity = SliccTabEntity(
            target: CDPTargetSummary(id: "t3", title: "", url: ""))
        XCTAssertNil(entity.url)
        XCTAssertEqual(entity.displayLabel, "Tab")
    }

    @MainActor
    func testQueryMatchesTitleAndURLAndResolvesByIdentifier() async throws {
        let query = SliccTabQuery(tabs: { self.targets })
        let byTitle = try await query.entities(matching: "docs")
        XCTAssertEqual(byTitle.map(\.id), ["t1"])
        // The URL is fair game: a user says "the login one", and the word is
        // only in the address.
        let byURL = try await query.entities(matching: "login")
        XCTAssertEqual(byURL.map(\.id), ["t2"])
        let byId = try await query.entities(for: ["t2", "nope"])
        XCTAssertEqual(byId.map(\.id), ["t2"])
    }

    @MainActor
    func testEmptyNeedleListsEveryOpenTab() async throws {
        let query = SliccTabQuery(tabs: { self.targets })
        let all = try await query.entities(matching: " ")
        XCTAssertEqual(all.map(\.id), ["t1", "t2"])
    }

    /// Tabs are live `CDPBridge` state — nothing persists them. A query with
    /// the app cold answers empty, which is the truth, not a bug.
    @MainActor
    func testColdAppHasNoTabs() async throws {
        let query = SliccTabQuery(tabs: { [] })
        let suggested = try await query.suggestedEntities()
        XCTAssertTrue(suggested.isEmpty)
    }

    @MainActor
    func testRegistryPublishesTheLiveList() {
        SliccTabRegistry.shared.publish(targets)
        XCTAssertEqual(SliccTabRegistry.shared.tabs.map(\.id), ["t1", "t2"])
        SliccTabRegistry.shared.publish([])
        XCTAssertTrue(SliccTabRegistry.shared.tabs.isEmpty)
    }
}
