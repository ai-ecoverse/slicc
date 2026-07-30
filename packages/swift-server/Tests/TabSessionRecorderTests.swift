import XCTest

@testable import slicc_server

final class TabSessionRecorderTests: XCTestCase {
    private let sliccOrigins = ["https://www.sliccy.ai", "http://localhost:5710"]
    private static let defaultContext = "DEFAULT-CTX"
    private static let incognitoContext = "OTR-CTX"

    func testSnapshotPersistsPageTargetsAndSkipsTheSliccTab() async {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        let recorder = makeRecorder(
            store: store,
            targets: [
                (Self.defaultContext, "page", "https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp&bridgeToken=t"),
                (Self.defaultContext, "page", "https://example.com/a"),
                (Self.defaultContext, "service_worker", "https://example.com/sw.js"),
                (Self.defaultContext, "page", "chrome://settings"),
            ]
        )

        await recorder.snapshotNow()

        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/a"])
    }

    func testSnapshotNeverPersistsIncognitoTabs() async {
        // Incognito pages show up in the target list with nothing but their
        // browser context to tell them apart, and writing browsing the user
        // made private into a file on disk would outlive the session.
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        let recorder = makeRecorder(
            store: store,
            targets: [
                (Self.defaultContext, "page", "https://example.com/normal"),
                (Self.incognitoContext, "page", "https://example.com/private"),
            ]
        )

        await recorder.snapshotNow()

        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/normal"])
    }

    func testSnapshotIsSkippedWhenTheDefaultContextCannotBeIdentified() async {
        // `defaultBrowserContextId` is an optional CDP field. Without it every
        // tab is potentially Incognito, so the snapshot is skipped rather than
        // written optimistically.
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        store.save(urls: ["https://example.com/keep"], hostedOrigins: sliccOrigins)
        let recorder = makeRecorder(
            store: store,
            targets: [(Self.defaultContext, "page", "https://example.com/new")],
            defaultContextId: nil
        )

        await recorder.snapshotNow()

        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/keep"])
    }

    func testSnapshotReadsTheBrowserEndpointForTheConfiguredPort() async {
        let requested = RequestRecorder()
        let session = BrowserSessionStub(defaultContextId: Self.defaultContext, targets: [])
        let recorder = TabSessionRecorder(
            store: TabSessionStore(fileURL: makeTemporaryFileURL()),
            cdpPort: 9333,
            hostedOrigins: sliccOrigins,
            fetch: { url in
                await requested.record(url)
                return (200, Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/browser/abc"}"#.utf8))
            },
            openSession: { _ in session }
        )

        await recorder.snapshotNow()

        let urls = await requested.urls
        XCTAssertEqual(urls, ["http://127.0.0.1:9333/json/version"])
        // Browser-level reads only: a page attach could evict the webapp's
        // own `/cdp` session.
        let methods = await session.methods
        XCTAssertEqual(methods, ["Target.getBrowserContexts", "Target.getTargets"])
        let isClosed = await session.isClosed
        XCTAssertTrue(isClosed)
    }

    func testFailedOrNonSuccessProbeLeavesThePreviousSnapshotIntact() async {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())
        store.save(urls: ["https://example.com/keep"], hostedOrigins: sliccOrigins)
        let version = Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}"#.utf8)
        let queue = ResponseQueue(responses: [
            .failure(URLError(.cannotConnectToHost)),
            .success((500, version)),
            .success((200, Data("not json".utf8))),
            .success((200, Data("{}".utf8))),
            .success((200, version)),
        ])
        let recorder = TabSessionRecorder(
            store: store,
            cdpPort: 9222,
            hostedOrigins: sliccOrigins,
            fetch: { _ in try await queue.next() },
            // The last round reaches a browser that refuses the read.
            openSession: { _ in BrowserSessionStub(defaultContextId: nil, targets: [], failing: true) }
        )

        for _ in 0..<5 {
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
                return (200, Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}"#.utf8))
            },
            openSession: { _ in
                BrowserSessionStub(
                    defaultContextId: Self.defaultContext,
                    targets: [(Self.defaultContext, "page", "https://example.com/a")]
                )
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
        targets: [(context: String, type: String, url: String)],
        defaultContextId: String? = TabSessionRecorderTests.defaultContext
    ) -> TabSessionRecorder {
        TabSessionRecorder(
            store: store,
            cdpPort: 9222,
            hostedOrigins: sliccOrigins,
            fetch: { _ in
                (200, Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}"#.utf8))
            },
            openSession: { _ in
                BrowserSessionStub(defaultContextId: defaultContextId, targets: targets)
            }
        )
    }

    private func makeTemporaryFileURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("slicc-tab-recorder-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("tabs.json")
    }
}

/// Canned browser-level CDP endpoint: answers `Target.getBrowserContexts` and
/// `Target.getTargets` and records what was asked of it.
private actor BrowserSessionStub: CDPBrowserSession {
    private let defaultContextId: String?
    private let targets: [(context: String, type: String, url: String)]
    private let failing: Bool
    private(set) var methods: [String] = []
    private(set) var isClosed = false

    init(
        defaultContextId: String?,
        targets: [(context: String, type: String, url: String)],
        failing: Bool = false
    ) {
        self.defaultContextId = defaultContextId
        self.targets = targets
        self.failing = failing
    }

    func call(method: String) async throws -> Data {
        methods.append(method)
        if failing { throw CDPBrowserSessionError.noReply(method: method) }
        switch method {
        case "Target.getBrowserContexts":
            let payload = defaultContextId.map { #"{"defaultBrowserContextId":"\#($0)"}"# } ?? "{}"
            return Data(payload.utf8)
        case "Target.getTargets":
            let infos = targets.map {
                #"{"type":"\#($0.type)","url":"\#($0.url)","browserContextId":"\#($0.context)"}"#
            }
            return Data(#"{"targetInfos":[\#(infos.joined(separator: ","))]}"#.utf8)
        default:
            return Data("{}".utf8)
        }
    }

    func close() {
        isClosed = true
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
