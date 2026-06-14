import Foundation
@testable import SwiftOptel

/// Thread-safe mock ``OptelTransport`` that records every call instead of
/// performing network I/O. Shared by the transport and collector test suites.
final class RecordingTransport: OptelTransport, @unchecked Sendable {
    struct Call: Equatable {
        let event: RUMEvent
        let baseURL: URL
    }

    private let lock = NSLock()
    private var calls: [Call] = []

    var sent: [Call] {
        lock.lock(); defer { lock.unlock() }
        return calls
    }

    func send(_ event: RUMEvent, collectBaseURL: URL) {
        lock.lock()
        calls.append(Call(event: event, baseURL: collectBaseURL))
        lock.unlock()
    }

    func reset() {
        lock.lock()
        calls.removeAll()
        lock.unlock()
    }
}
