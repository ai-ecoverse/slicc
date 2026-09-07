import Foundation
import NIOCore

// The bounded, order-preserving inbound pump between Chrome's WebSocket
// callbacks and the `/cdp` proxy actor, plus the one-shot overflow marker the
// socket teardown reads. Split out of `CDPProxy.swift`; behaviour unchanged.

final class ChromeInboundMessagePump: @unchecked Sendable {
    enum EnqueueResult: Equatable {
        case enqueued
        case overflow
        case terminated
    }

    private enum NextState {
        case message(ProxyMessage)
        case finished
        case wait
    }

    private let maxBufferedMessages: Int
    private let stateQueue = DispatchQueue(label: "slicc.cdp-proxy.chrome-inbound-pump")
    private var buffer: [ProxyMessage] = []
    private var pendingContinuation: CheckedContinuation<ProxyMessage?, Never>?
    private var isFinished = false
    private var overflowSnapshot: [ProxyMessage]?

    init(maxBufferedMessages: Int = CDPProxy.defaultChromeInboundMessageBufferLimit) {
        self.maxBufferedMessages = max(1, maxBufferedMessages)
    }

    func enqueue(_ message: ProxyMessage) -> EnqueueResult {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?
        let result = self.stateQueue.sync { () -> EnqueueResult in
            guard !self.isFinished else {
                return .terminated
            }

            if let pendingContinuation = self.pendingContinuation {
                self.pendingContinuation = nil
                continuation = pendingContinuation
                return .enqueued
            }

            guard self.buffer.count < self.maxBufferedMessages else {
                self.isFinished = true
                // Snapshot (O(1), copy-on-write) so the overflow can be
                // attributed after the pump has drained the buffer.
                self.overflowSnapshot = self.buffer
                return .overflow
            }

            self.buffer.append(message)
            return .enqueued
        }

        continuation?.resume(returning: message)
        return result
    }

    /// Method/session attribution for the frames that were queued when the cap
    /// was hit; `nil` until an `enqueue` returns `.overflow`.
    func overflowDiagnosticsSummary() -> String? {
        let snapshot = self.stateQueue.sync { self.overflowSnapshot }
        guard let snapshot else {
            return nil
        }
        return ChromeInboundOverflowDiagnostics.summary(for: snapshot)
    }

    func next() async -> ProxyMessage? {
        switch self.nextState() {
        case .message(let message):
            return message
        case .finished:
            return nil
        case .wait:
            return await withCheckedContinuation { continuation in
                var nextState: NextState?

                self.stateQueue.sync {
                    if !self.buffer.isEmpty {
                        nextState = .message(self.buffer.removeFirst())
                        return
                    }

                    if self.isFinished {
                        nextState = .finished
                        return
                    }

                    self.pendingContinuation = continuation
                }

                switch nextState {
                case .message(let message):
                    continuation.resume(returning: message)
                case .finished:
                    continuation.resume(returning: nil)
                case .wait, .none:
                    break
                }
            }
        }
    }

    func finish() {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?

        self.stateQueue.sync {
            guard !self.isFinished else {
                return
            }

            self.isFinished = true
            continuation = self.pendingContinuation
            self.pendingContinuation = nil
        }

        continuation?.resume(returning: nil)
    }

    private func nextState() -> NextState {
        self.stateQueue.sync {
            if !self.buffer.isEmpty {
                return .message(self.buffer.removeFirst())
            }

            if self.isFinished {
                return .finished
            }

            return .wait
        }
    }
}

final class ChromeSocketTerminationState: @unchecked Sendable {
    private let lock = NSLock()
    private var overflowDescription: String?

    func markOverflow(reason: String) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }

        guard self.overflowDescription == nil else {
            return false
        }

        self.overflowDescription = reason
        return true
    }

    func overflowDescriptionSnapshot() -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.overflowDescription
    }
}
