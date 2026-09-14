import SliccTrayKit
import XCTest

@testable import SliccFollower



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
        
        
        XCTAssertFalse(entity.isPrivate)
    }

    
    
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
