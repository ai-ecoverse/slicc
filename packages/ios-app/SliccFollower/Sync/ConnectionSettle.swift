import Foundation






struct ConnectionHealth: Equatable {
    var state: ConnectionState
    
    var isStalled: Bool
    
    var reconnectAttempt: Int

    
    
    var isHealthy: Bool { state == .connected && !isStalled }

    init(state: ConnectionState, isStalled: Bool = false, reconnectAttempt: Int = 0) {
        self.state = state
        self.isStalled = isStalled
        self.reconnectAttempt = reconnectAttempt
    }
}

























@MainActor
final class ConnectionSettler {
    
    
    
    
    
    
    
    static let holdDuration: Duration = .seconds(2)

    
    private(set) var settled: ConnectionHealth

    
    
    var onChange: ((ConnectionHealth) -> Void)?

    private let holdDuration: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    
    private var hold: Task<Void, Never>?
    private var pending: ConnectionHealth?

    
    
    
    
    
    
    init(
        initial: ConnectionHealth,
        holdDuration: Duration = ConnectionSettler.holdDuration,
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        }
    ) {
        self.settled = initial
        self.holdDuration = holdDuration
        self.sleep = sleep
    }

    
    
    func ingest(_ raw: ConnectionHealth) {
        guard !raw.isHealthy, settled.isHealthy else {
            
            
            
            
            cancelHold()
            guard raw != settled else { return }
            publish(raw)
            return
        }

        pending = raw
        
        guard hold == nil else { return }

        let sleep = sleep
        let holdDuration = holdDuration
        hold = Task { @MainActor [weak self] in
            try? await sleep(holdDuration)
            guard !Task.isCancelled, let self, let trouble = self.pending else { return }
            self.hold = nil
            self.pending = nil
            self.publish(trouble)
        }
    }

    
    
    
    func settleImmediately(_ raw: ConnectionHealth) {
        cancelHold()
        guard raw != settled else { return }
        publish(raw)
    }

    private func cancelHold() {
        hold?.cancel()
        hold = nil
        pending = nil
    }

    private func publish(_ raw: ConnectionHealth) {
        settled = raw
        onChange?(raw)
    }

    deinit {
        hold?.cancel()
    }
}
