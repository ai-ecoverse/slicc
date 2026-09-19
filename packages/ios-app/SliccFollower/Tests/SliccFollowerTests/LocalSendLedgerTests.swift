import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

final class LocalSendLedgerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func message(_ id: String) -> ChatMessage {
        ChatMessage(id: id, role: .user, content: id, timestamp: 1)
    }

    func testMissingSendsAreRestoredInTheOrderTheyWereSent() {
        var ledger = LocalSendLedger()
        ledger.record(message("second"), scoopJid: "b", now: start.addingTimeInterval(2))
        ledger.record(message("first"), scoopJid: "b", now: start.addingTimeInterval(1))

        let merged = ledger.reconcile(
            snapshot: [message("old")], scoopJid: "b", now: start.addingTimeInterval(3))

        XCTAssertEqual(merged.map(\.id), ["old", "first", "second"])
        XCTAssertTrue(ledger.owns("first"), "still unconfirmed, so still held")
    }

    func testASendBelongsOnlyToTheUnitItWasSentUnder() {
        var ledger = LocalSendLedger()
        ledger.record(message("for-b"), scoopJid: "b", now: start)

        let merged = ledger.reconcile(snapshot: [], scoopJid: "a", now: start)

        XCTAssertEqual(merged.map(\.id), [])
        XCTAssertTrue(ledger.owns("for-b"), "another unit's snapshot confirms nothing")
    }

    func testAnExpiredSendStopsOutrankingTheLeader() {
        var ledger = LocalSendLedger()
        ledger.record(message("lost"), scoopJid: "b", now: start)
        let later = start.addingTimeInterval(LocalSendLedger.confirmationWindow + 1)

        XCTAssertEqual(ledger.reconcile(snapshot: [], scoopJid: "b", now: later).map(\.id), [])
        XCTAssertFalse(ledger.owns("lost"))
    }

    func testASendRefusedByTheTransportComesBackStillFlagged() throws {
        var ledger = LocalSendLedger()
        ledger.record(message("refused"), scoopJid: "b", now: start)
        ledger.flagUndelivered("refused")

        let merged = ledger.reconcile(snapshot: [message("old")], scoopJid: "b", now: start)

        XCTAssertEqual(merged.map(\.id), ["old", "refused"])
        XCTAssertEqual(try XCTUnwrap(merged.last).error, true, "still 'Not delivered'")
    }

    func testASendMadeBeforeAnyUnitWasSelectedIsAdoptedByTheFirstSnapshot() {
        var ledger = LocalSendLedger()
        ledger.record(message("early"), scoopJid: nil, now: start)

        let first = ledger.reconcile(snapshot: [message("old")], scoopJid: "cone", now: start)
        XCTAssertEqual(first.map(\.id), ["old", "early"])

        // Adopted means scoped: another unit's snapshot does not inherit it.
        XCTAssertEqual(ledger.reconcile(snapshot: [], scoopJid: "other", now: start).map(\.id), [])
        XCTAssertEqual(
            ledger.reconcile(snapshot: [], scoopJid: "cone", now: start).map(\.id), ["early"])
    }

    func testRemoveAllReleasesEveryEntry() {
        var ledger = LocalSendLedger()
        ledger.record(message("m1"), scoopJid: "b", now: start)
        ledger.removeAll()
        XCTAssertFalse(ledger.owns("m1"))
        XCTAssertEqual(ledger.reconcile(snapshot: [], scoopJid: "b", now: start).map(\.id), [])
    }
}
