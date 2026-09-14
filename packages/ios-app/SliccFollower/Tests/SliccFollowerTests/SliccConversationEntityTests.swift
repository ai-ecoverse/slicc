import SliccWidgetKit
import XCTest

@testable import SliccFollower







final class SliccConversationEntityTests: XCTestCase {

    private func unit(
        _ id: String,
        name: String,
        role: WidgetUnit.Role = .cone,
        detail: String? = nil,
        lifecycle: WidgetUnit.Lifecycle = .idle,
        model: String? = nil,
        isActive: Bool = false,
        at seconds: TimeInterval? = nil
    ) -> WidgetUnit {
        WidgetUnit(
            id: id,
            name: name,
            role: role,
            lifecycle: lifecycle,
            model: model,
            detail: detail,
            isActive: isActive,
            lastActivityAt: seconds.map { Date(timeIntervalSince1970: $0) })
    }

    

    func testEntityCarriesTheFieldsSiriAndSpotlightRead() {
        let entity = SliccConversationProjection.entity(
            from: unit(
                "jid-1", name: "Deploy", role: .scoop, detail: "ship the worker",
                lifecycle: .working, model: "claude-opus-4-6"))

        XCTAssertEqual(entity.id, "jid-1")
        XCTAssertEqual(entity.name, "Deploy")
        XCTAssertEqual(entity.detail, "ship the worker")
        XCTAssertEqual(entity.model, "claude-opus-4-6")
        XCTAssertEqual(entity.status, "working")
        XCTAssertFalse(entity.isCone)
    }

    

    func testActiveUnitOutranksEverythingElse() {
        let ranked = SliccConversationProjection.ranked([
            unit("a", name: "Alpha", at: 900),
            unit("b", name: "Bravo", role: .scoop, isActive: true, at: 100),
        ])
        XCTAssertEqual(ranked.map(\.id), ["b", "a"])
    }

    func testConesOutrankScoopsThenRecencyThenName() {
        let ranked = SliccConversationProjection.ranked([
            unit("scoop", name: "Aaa", role: .scoop, at: 900),
            unit("older-cone", name: "Zzz", at: 100),
            unit("newer-cone", name: "Mmm", at: 500),
        ])
        XCTAssertEqual(ranked.map(\.id), ["newer-cone", "older-cone", "scoop"])
    }

    
    
    
    func testUndatedUnitsFallBackToNameOrder() {
        let ranked = SliccConversationProjection.ranked([
            unit("z", name: "Zebra"),
            unit("a", name: "apple"),
        ])
        XCTAssertEqual(ranked.map(\.id), ["a", "z"])
    }

    

    func testMatchIsCaseAndDiacriticInsensitiveAcrossNameAndDetail() {
        let units = [
            unit("1", name: "Café Refactor"),
            unit("2", name: "Unrelated", detail: "REFACTOR the parser"),
            unit("3", name: "Nothing"),
        ]
        XCTAssertEqual(
            Set(SliccConversationProjection.matching("refactor", in: units).map(\.id)),
            ["1", "2"])
        XCTAssertEqual(
            SliccConversationProjection.matching("cafe", in: units).map(\.id), ["1"])
    }

    
    func testEmptyNeedleListsEverythingRanked() {
        let units = [unit("s", name: "S", role: .scoop), unit("c", name: "C")]
        XCTAssertEqual(SliccConversationProjection.matching("   ", in: units).map(\.id), ["c", "s"])
    }

    func testNoMatchReturnsEmptyRatherThanEverything() {
        let units = [unit("1", name: "Deploy")]
        XCTAssertTrue(SliccConversationProjection.matching("zzzz", in: units).isEmpty)
    }

    func testResultsAreCappedSoDisambiguationStaysShort() {
        let many = (0..<100).map { unit("id-\($0)", name: "Unit \($0)") }
        XCTAssertEqual(
            SliccConversationProjection.entities(many).count,
            SliccConversationProjection.maximumResults)
    }

    

    func testQueryResolvesByIdentifierAndIgnoresUnknownOnes() async throws {
        let query = SliccConversationQuery(units: {
            [self.unit("a", name: "Alpha"), self.unit("b", name: "Bravo")]
        })
        let resolved = try await query.entities(for: ["b", "does-not-exist"])
        XCTAssertEqual(resolved.map(\.id), ["b"])
    }

    func testQueryMatchesSpokenTextAndSuggestsRanked() async throws {
        let query = SliccConversationQuery(units: {
            [
                self.unit("scoop", name: "Parser", role: .scoop, at: 900),
                self.unit("cone", name: "Deploy", at: 100),
            ]
        })
        let matched = try await query.entities(matching: "parser")
        XCTAssertEqual(matched.map(\.id), ["scoop"])
        let suggested = try await query.suggestedEntities()
        XCTAssertEqual(suggested.map(\.id), ["cone", "scoop"])
    }

    
    
    func testQueryWithNoSnapshotIsEmptyNotAFailure() async throws {
        let query = SliccConversationQuery(units: { [] })
        let suggested = try await query.suggestedEntities()
        let matched = try await query.entities(matching: "anything")
        let byId = try await query.entities(for: ["a"])
        XCTAssertTrue(suggested.isEmpty)
        XCTAssertTrue(matched.isEmpty)
        XCTAssertTrue(byId.isEmpty)
    }
}
