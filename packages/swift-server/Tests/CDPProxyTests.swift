import Logging
import NIOCore
import NIOWebSocket
import XCTest
@testable import slicc_server

final class CDPProxyTests: XCTestCase {
    func testPreWarmDiscoversAndReusesChromeConnection() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { port in
                XCTAssertEqual(port, 9222)
                return "ws://127.0.0.1:9222/devtools/browser/test"
            },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )

        try await proxy.preWarm(cdpPort: 9222)
        try await proxy.preWarm(cdpPort: 9222)

        XCTAssertEqual(harness.connectCountSnapshot(), 1)
        XCTAssertEqual(harness.connectedURLsSnapshot(), ["ws://127.0.0.1:9222/devtools/browser/test"])
    }

    func testBuffersMessagesWhileChromeConnectsAndFlushesAfterOpen() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }

        await proxy.receive(.text("{\"id\":1}"), from: client.handle.id)
        XCTAssertEqual(harness.sentTextsSnapshot(), [])

        await harness.resumePendingConnection()
        await prepareTask.value

        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":1}"])
    }

    func testNewClientClosesPreviousAndReceivesChromeMessages() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let firstClient = ClientRecorder()
        let secondClient = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(firstClient.handle)
        await proxy.addClient(secondClient.handle)
        await harness.emitText("{\"id\":7}")

        XCTAssertEqual(firstClient.closeReasonsSnapshot(), ["Replaced by newer /cdp client"])
        XCTAssertEqual(firstClient.sentTextsSnapshot(), [])
        XCTAssertEqual(secondClient.sentTextsSnapshot(), ["{\"id\":7}"])
    }

    func testChromeCloseReconnectsAndFlushesBufferedMessages() async throws {
        let reconnectGate = AsyncGate()
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in await reconnectGate.wait() }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)

        await harness.emitEvent(.closed("code=Optional(messageTooLarge)"))
        await proxy.receive(.text("{\"id\":24,\"method\":\"Target.getTargets\"}"), from: client.handle.id)

        XCTAssertEqual(harness.connectCountSnapshot(), 1)
        XCTAssertEqual(harness.sentTextsSnapshot(), [])

        await reconnectGate.open()
        for _ in 0..<200 {
            if harness.connectCountSnapshot() >= 2 {
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(harness.connectCountSnapshot(), 2)
        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":24,\"method\":\"Target.getTargets\"}"])
    }

    func testChromeReconnectRediscoversCDPURL() async throws {
        let reconnectGate = AsyncGate()
        let discoverer = DiscovererHarness(urls: [
            "ws://127.0.0.1:9222/devtools/browser/first",
            "ws://127.0.0.1:9222/devtools/browser/second",
        ])
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { port in
                await discoverer.discover(port: port)
            },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in await reconnectGate.wait() }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)

        await harness.emitEvent(.closed("code=Optional(normalClosure)"))
        await reconnectGate.open()

        for _ in 0..<200 {
            if harness.connectCountSnapshot() >= 2 {
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(harness.connectedURLsSnapshot(), [
            "ws://127.0.0.1:9222/devtools/browser/first",
            "ws://127.0.0.1:9222/devtools/browser/second",
        ])
        let discovererCallCount = await discoverer.callCount()
        XCTAssertEqual(discovererCallCount, 2)
    }

    func testBufferedMessagesDropOldestWhenBufferReachesLimit() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }

        for id in 1...1_001 {
            await proxy.receive(.text("{\"id\":\(id)}"), from: client.handle.id)
        }

        await harness.resumePendingConnection()
        await prepareTask.value

        let sentTexts = harness.sentTextsSnapshot()
        XCTAssertEqual(sentTexts.count, 1_000)
        XCTAssertEqual(sentTexts.first, "{\"id\":2}")
        XCTAssertEqual(sentTexts.last, "{\"id\":1001}")
    }

    func testChromeMessagePumpPreservesInboundMessageOrder() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 4)
        let recorder = PumpMessageRecorder()

        let pumpTask = Task {
            await CDPProxy.runChromeMessagePump(messagePump) { message in
                await recorder.record(message)
            }
        }

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)
        messagePump.finish()

        _ = await pumpTask.value

        let receivedTexts = await recorder.snapshot()
        XCTAssertEqual(receivedTexts, ["{\"id\":1}", "{\"id\":2}"])
    }

    func testChromeMessagePumpOverflowStopsAcceptingNewFramesAndDrainsBufferedFrames() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 2)
        let recorder = PumpMessageRecorder()

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":3}")), .overflow)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":4}")), .terminated)

        await CDPProxy.runChromeMessagePump(messagePump) { message in
            await recorder.record(message)
        }

        let receivedTexts = await recorder.snapshot()
        XCTAssertEqual(receivedTexts, ["{\"id\":1}", "{\"id\":2}"])
    }

    func testChromeSocketTerminationWaitsForPumpDrainBeforeReportingClose() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 4)
        let recorder = BlockingPumpMessageRecorder()
        let closeEvents = ChromeSocketEventRecorder()

        let pumpTask = Task {
            await CDPProxy.runChromeMessagePump(messagePump) { message in
                await recorder.record(message)
            }
        }

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        await recorder.waitForFirstMessage()
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)

        let terminationTask = Task {
            await CDPProxy.handleChromeSocketTermination(
                messagePump: messagePump,
                messagePumpTask: pumpTask,
                result: Result<Void, Error>.success(()),
                closeDescription: "code=nil",
                overflowDescription: nil,
                onEvent: { event in
                    await closeEvents.record(event)
                }
            )
        }

        let initialEvents = await closeEvents.snapshot()
        XCTAssertEqual(initialEvents, [])

        await recorder.releaseFirstMessage()
        _ = await terminationTask.value

        let recordedMessages = await recorder.snapshot()
        let finalEvents = await closeEvents.snapshot()
        XCTAssertEqual(recordedMessages, ["{\"id\":1}", "{\"id\":2}"])
        XCTAssertEqual(finalEvents, ["closed: code=nil"])
    }
}

private final class ClientRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sentTexts: [String] = []
    private var closeReasons: [String] = []

    lazy var handle: ClientHandle = ClientHandle(
        send: { [weak self] message in
            guard let self else { return }
            switch message {
            case .text(let text):
                self.recordSentText(text)
            case .binary:
                XCTFail("Expected text-only message in test client")
            }
        },
        close: { [weak self] _, reason in
            self?.recordCloseReason(reason)
        }
    )

    func sentTextsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.sentTexts
    }

    func closeReasonsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.closeReasons
    }

    private func recordSentText(_ text: String) {
        self.lock.lock()
        self.sentTexts.append(text)
        self.lock.unlock()
    }

    private func recordCloseReason(_ reason: String?) {
        self.lock.lock()
        self.closeReasons.append(reason ?? "")
        self.lock.unlock()
    }
}

private final class ChromeConnectorHarness: @unchecked Sendable {
    private let gate: AsyncGate?
    private let state = HarnessState()

    init(waitForExplicitResume: Bool = false) {
        self.gate = waitForExplicitResume ? AsyncGate() : nil
    }

    func connect(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        self.state.recordConnect(url: url, onMessage: onMessage, onEvent: onEvent)
        self.state.setOpen(true)

        if let gate {
            await gate.wait()
        }

        return ChromeSocketHandle(
            send: { [weak self] message in
                self?.recordSend(message)
            },
            close: { [weak self] in
                self?.setOpen(false)
            },
            isOpen: { [weak self] in
                self?.isOpenSnapshot() ?? false
            }
        )
    }

    func resumePendingConnection() async {
        await self.gate?.open()
    }

    func emitText(_ text: String) async {
        let callback = self.messageCallbackSnapshot()
        await callback?(.text(text))
    }

    func emitEvent(_ event: ChromeSocketEvent) async {
        let callback = self.eventCallbackSnapshot()
        await callback?(event)
    }

    func connectCountSnapshot() -> Int {
        self.state.connectCountSnapshot()
    }

    func connectedURLsSnapshot() -> [String] {
        self.state.connectedURLsSnapshot()
    }

    func sentTextsSnapshot() -> [String] {
        self.state.sentTextsSnapshot()
    }

    private func recordSend(_ message: ProxyMessage) {
        self.state.recordSend(message)
    }

    private func messageCallbackSnapshot() -> (@Sendable (ProxyMessage) async -> Void)? {
        self.state.messageCallbackSnapshot()
    }

    private func eventCallbackSnapshot() -> (@Sendable (ChromeSocketEvent) async -> Void)? {
        self.state.eventCallbackSnapshot()
    }

    private func isOpenSnapshot() -> Bool {
        self.state.isOpenSnapshot()
    }

    private func setOpen(_ isOpen: Bool) {
        self.state.setOpen(isOpen)
    }
}

private final class HarnessState: @unchecked Sendable {
    private let lock = NSLock()
    private var connectCount = 0
    private var connectedURLs: [String] = []
    private var sentTexts: [String] = []
    private var onMessage: (@Sendable (ProxyMessage) async -> Void)?
    private var onEvent: (@Sendable (ChromeSocketEvent) async -> Void)?
    private var isOpen = true

    func recordConnect(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) {
        self.lock.lock()
        self.connectCount += 1
        self.connectedURLs.append(url)
        self.onMessage = onMessage
        self.onEvent = onEvent
        self.lock.unlock()
    }

    func recordSend(_ message: ProxyMessage) {
        self.lock.lock()
        defer { self.lock.unlock() }
        switch message {
        case .text(let text):
            self.sentTexts.append(text)
        case .binary(let buffer):
            self.sentTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func connectCountSnapshot() -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectCount
    }

    func connectedURLsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectedURLs
    }

    func sentTextsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.sentTexts
    }

    func messageCallbackSnapshot() -> (@Sendable (ProxyMessage) async -> Void)? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.onMessage
    }

    func eventCallbackSnapshot() -> (@Sendable (ChromeSocketEvent) async -> Void)? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.onEvent
    }

    func isOpenSnapshot() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.isOpen
    }

    func setOpen(_ isOpen: Bool) {
        self.lock.lock()
        self.isOpen = isOpen
        self.lock.unlock()
    }
}

private actor DiscovererHarness {
    private let urls: [String]
    private var nextIndex = 0

    init(urls: [String]) {
        self.urls = urls
    }

    func discover(port: Int) -> String {
        XCTAssertEqual(port, 9222)
        let index = min(self.nextIndex, self.urls.count - 1)
        self.nextIndex += 1
        return self.urls[index]
    }

    func callCount() -> Int {
        self.nextIndex
    }
}

private actor AsyncGate {
    private var isOpen = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !self.isOpen else {
            return
        }

        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }

    func open() {
        guard !self.isOpen else {
            return
        }

        self.isOpen = true
        let pendingContinuations = self.continuations
        self.continuations.removeAll()
        for continuation in pendingContinuations {
            continuation.resume()
        }
    }
}

private actor PumpMessageRecorder {
    private var recordedTexts: [String] = []

    func record(_ message: ProxyMessage) {
        switch message {
        case .text(let text):
            self.recordedTexts.append(text)
        case .binary(let buffer):
            self.recordedTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func snapshot() -> [String] {
        self.recordedTexts
    }
}

private actor BlockingPumpMessageRecorder {
    private let firstMessageGate = AsyncGate()
    private let releaseGate = AsyncGate()
    private var recordedTexts: [String] = []
    private var shouldBlockFirstMessage = true

    func record(_ message: ProxyMessage) async {
        if self.shouldBlockFirstMessage {
            self.shouldBlockFirstMessage = false
            await self.firstMessageGate.open()
            await self.releaseGate.wait()
        }

        switch message {
        case .text(let text):
            self.recordedTexts.append(text)
        case .binary(let buffer):
            self.recordedTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func waitForFirstMessage() async {
        await self.firstMessageGate.wait()
    }

    func releaseFirstMessage() async {
        await self.releaseGate.open()
    }

    func snapshot() -> [String] {
        self.recordedTexts
    }
}

private actor ChromeSocketEventRecorder {
    private var events: [String] = []

    func record(_ event: ChromeSocketEvent) {
        switch event {
        case .closed(let description):
            self.events.append("closed: \(description)")
        case .error(let description):
            self.events.append("error: \(description)")
        }
    }

    func snapshot() -> [String] {
        self.events
    }
}
