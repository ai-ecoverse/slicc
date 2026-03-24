import XCTest
@testable import slicc_server

final class LogDedupTests: XCTestCase {
    func testSuppressesFingerprintDuplicatesAndFlushesSummary() {
        let outputs = OutputCollector()
        let dedup = CliLogDedup(prefix: "[page]", sink: { outputs.append($0) })

        XCTAssertTrue(dedup.shouldLog("connected to target 1234"))
        XCTAssertFalse(dedup.shouldLog("connected to target 5678"))
        dedup.flush()

        let snapshot = outputs.snapshot()
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(snapshot[0], #"[page] (suppressed 1 similar: "connected to target 1234")"#)
    }

    func testEvictsExpiredEntries() {
        let outputs = OutputCollector()
        let dedup = CliLogDedup(prefix: "[page]", window: 0.01, sink: { outputs.append($0) })

        XCTAssertTrue(dedup.shouldLog("session 123 started"))
        XCTAssertFalse(dedup.shouldLog("session 456 started"))
        Thread.sleep(forTimeInterval: 0.02)
        XCTAssertTrue(dedup.shouldLog("new message"))

        let snapshot = outputs.snapshot()
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertTrue(snapshot[0].contains("suppressed 1 similar"))
    }
}

private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func append(_ value: String) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}