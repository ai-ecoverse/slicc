import Logging
import NIOCore
import NIOWebSocket
import XCTest

@testable import slicc_server

// Shared doubles for the `CDPProxy` suites (`CDPProxyTests`,
// `CDPProxyUpstreamResetTests`): an injectable Chrome connector, a `/cdp`
// client recorder, and the gates that make the proxy's detached reconnect
// tasks steppable.

extension XCTestCase {
    /// Poll `condition` (the proxy hands work to detached tasks, so state
    /// changes are observed rather than awaited).
    func waitUntil(
        _ description: String,
        timeoutMilliseconds: Int = 2_000,
        condition: () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<(timeoutMilliseconds / 10) {
            if condition() {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTFail("Timed out waiting for \(description)", file: file, line: line)
    }
}

final class ClientRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sentTexts: [String] = []
    private var closeReasons: [String] = []
    private var closeCodes: [WebSocketErrorCode] = []

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
        close: { [weak self] code, reason in
            self?.recordClose(code: code, reason: reason)
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

    func closeCodesSnapshot() -> [WebSocketErrorCode] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.closeCodes
    }

    private func recordSentText(_ text: String) {
        self.lock.lock()
        self.sentTexts.append(text)
        self.lock.unlock()
    }

    private func recordClose(code: WebSocketErrorCode, reason: String?) {
        self.lock.lock()
        self.closeCodes.append(code)
        self.closeReasons.append(reason ?? "")
        self.lock.unlock()
    }
}

final class ChromeConnectorHarness: @unchecked Sendable {
    private let gate: AsyncGate?
    private let holdGate = AsyncGate()
    private let state = HarnessState()

    init(waitForExplicitResume: Bool = false) {
        self.gate = waitForExplicitResume ? AsyncGate() : nil
    }

    func connect(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        if self.state.consumeQueuedFailure() {
            throw CDPProxyError.discoveryFailed("Simulated Chrome connect failure")
        }

        self.state.recordConnect(url: url, onMessage: onMessage, onEvent: onEvent)
        self.state.setOpen(true)

        if self.state.holdConnectsSnapshot() {
            await self.holdGate.wait()
        }

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

    /// Make the next `count` connect attempts throw, simulating a Chrome that
    /// has not come back yet.
    func failNextConnects(_ count: Int) {
        self.state.queueConnectFailures(count)
    }

    /// Park subsequent connects after they are recorded, so a test can observe
    /// the window where the Chrome leg is mid-reconnect.
    func holdConnectsUntilReleased() {
        self.state.setHoldConnects(true)
    }

    func releaseHeldConnects() async {
        await self.holdGate.open()
    }

    func connectCountSnapshot() -> Int {
        self.state.connectCountSnapshot()
    }

    /// Connect attempts including the ones that threw.
    func connectAttemptCountSnapshot() -> Int {
        self.state.connectAttemptCountSnapshot()
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

final class HarnessState: @unchecked Sendable {
    private let lock = NSLock()
    private var connectCount = 0
    private var connectedURLs: [String] = []
    private var sentTexts: [String] = []
    private var onMessage: (@Sendable (ProxyMessage) async -> Void)?
    private var onEvent: (@Sendable (ChromeSocketEvent) async -> Void)?
    private var isOpen = true
    private var connectAttemptCount = 0
    private var queuedConnectFailures = 0
    private var holdConnects = false

    func setHoldConnects(_ holdConnects: Bool) {
        self.lock.lock()
        self.holdConnects = holdConnects
        self.lock.unlock()
    }

    func holdConnectsSnapshot() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.holdConnects
    }

    func queueConnectFailures(_ count: Int) {
        self.lock.lock()
        self.queuedConnectFailures += count
        self.lock.unlock()
    }

    /// Counts the attempt and reports whether it must fail.
    func consumeQueuedFailure() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.connectAttemptCount += 1
        guard self.queuedConnectFailures > 0 else {
            return false
        }
        self.queuedConnectFailures -= 1
        return true
    }

    func connectAttemptCountSnapshot() -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectAttemptCount
    }

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

actor DiscovererHarness {
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

actor AsyncGate {
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

/// One-permit-per-`step()` gate: unlike `AsyncGate` it never latches open, so a
/// retry loop whose sleep waits on it can be advanced one iteration at a time.
actor StepGate {
    private var permits = 0
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if self.permits > 0 {
            self.permits -= 1
            return
        }

        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }

    func step() {
        guard !self.continuations.isEmpty else {
            self.permits += 1
            return
        }

        self.continuations.removeFirst().resume()
    }
}

actor PumpMessageRecorder {
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

actor BlockingPumpMessageRecorder {
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

actor ChromeSocketEventRecorder {
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
