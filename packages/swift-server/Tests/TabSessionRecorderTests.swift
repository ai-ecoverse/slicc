import XCTest

@testable import slicc_server

final class TabSessionRecorderTests: XCTestCase {
    private let sliccOrigins = ["https://www.sliccy.ai", "http://localhost:5710"]

    func testSnapshotPersistsPageTargetsAndSkipsTheSliccTab() async {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        let payload = """
            [
              {"type":"page","url":"https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp&bridgeToken=t"},
              {"type":"page","url":"https://example.com/a"},
              {"type":"service_worker","url":"https://example.com/sw.js"},
              {"type":"page","url":"chrome://settings"}
            ]
            """
        let recorder = makeRecorder(store: store, responses: [.success((200, Data(payload.utf8)))])

        await recorder.snapshotNow()

        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/a"])
    }

    func testSnapshotRequestsTheCdpTargetListForTheConfiguredPort() async {
        let requested = RequestRecorder()
        let recorder = TabSessionRecorder(
            store: TabSessionStore(fileURL: makeTemporaryFileURL()),
            cdpPort: 9333,
            hostedOrigins: sliccOrigins,
            fetch: { url in
                await requested.record(url)
                return (200, Data("[]".utf8))
            }
        )

        await recorder.snapshotNow()

        let urls = await requested.urls
        XCTAssertEqual(urls, ["http://127.0.0.1:9333/json/list"])
    }

    func testFailedOrNonSuccessProbeLeavesThePreviousSnapshotIntact() async {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        store.save(urls: ["https://example.com/keep"], hostedOrigins: sliccOrigins)
        let good = Data(#"[{"type":"page","url":"https://example.com/new"}]"#.utf8)
        let recorder = makeRecorder(
            store: store,
            responses: [
                .failure(URLError(.cannotConnectToHost)),
                .success((500, good)),
                .success((200, Data("not json".utf8))),
            ]
        )

        for _ in 0..<3 {
            await recorder.snapshotNow()
            XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/keep"])
        }
    }

    func testStartPollsRepeatedlyUntilStopped() async throws {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        let requested = RequestRecorder()
        let recorder = TabSessionRecorder(
            store: store,
            cdpPort: 9222,
            hostedOrigins: sliccOrigins,
            intervalNanoseconds: 1_000_000,
            fetch: { url in
                await requested.record(url)
                return (200, Data(#"[{"type":"page","url":"https://example.com/a"}]"#.utf8))
            }
        )

        await recorder.start()
        for _ in 0..<200 where await requested.urls.count < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        await recorder.stop()
        let afterStop = await requested.urls.count

        XCTAssertGreaterThanOrEqual(afterStop, 2)
        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/a"])
        // A stopped recorder stays stopped: the poll loop is cancelled, not paused.
        try await Task.sleep(nanoseconds: 50_000_000)
        let settled = await requested.urls.count
        XCTAssertEqual(settled, afterStop)
    }

    private func makeRecorder(
        store: TabSessionStore,
        responses: [Result<(Int, Data), Error>]
    ) -> TabSessionRecorder {
        let queue = ResponseQueue(responses: responses)
        return TabSessionRecorder(
            store: store,
            cdpPort: 9222,
            hostedOrigins: sliccOrigins,
            fetch: { _ in try await queue.next() }
        )
    }

    private func makeTemporaryFileURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("slicc-tab-recorder-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("tabs.json")
    }
}

private actor ResponseQueue {
    private var responses: [Result<(Int, Data), Error>]

    init(responses: [Result<(Int, Data), Error>]) {
        self.responses = responses
    }

    func next() async throws -> (Int, Data) {
        guard !responses.isEmpty else { throw URLError(.cannotConnectToHost) }
        return try responses.removeFirst().get()
    }
}

private actor RequestRecorder {
    private(set) var urls: [String] = []

    func record(_ url: URL) {
        urls.append(url.absoluteString)
    }
}
