import Foundation

/// What the chat surface is allowed to say about the transport, as one value.
///
/// Everything the avatar and the composer need travels together so a held-back
/// transition cannot be published in halves — a settled `connected` beside a
/// live "Reconnecting… (2/10)" would put calm eyes over an alarmed placeholder.
struct ConnectionHealth: Equatable {
    var state: ConnectionState
    /// The leader stopped answering pings while its channel stayed open.
    var isStalled: Bool
    /// Which reconnect attempt is in flight, 1-based; zero when not reconnecting.
    var reconnectAttempt: Int

    /// A connected leader that is still answering. Anything else is trouble and
    /// earns the static-eyed treatment.
    var isHealthy: Bool { state == .connected && !isStalled }

    init(state: ConnectionState, isStalled: Bool = false, reconnectAttempt: Int = 0) {
        self.state = state
        self.isStalled = isStalled
        self.reconnectAttempt = reconnectAttempt
    }
}

/// Holds a transition INTO connection trouble for `holdDuration` before the UI
/// is allowed to show it.
///
/// The follower's WebRTC link blips: an ICE failure or a closed data channel
/// tears down a connection that the bounded reconnect then rebuilds within a
/// couple of seconds. Rendering every one of those cost more than it bought —
/// the avatar flashed TV static and the composer changed under a user who was
/// mid-sentence, for a fault that was already over.
///
/// So the two directions are deliberately asymmetric:
///
/// - **Into trouble** — held. A blip that heals inside the window never reaches
///   the UI at all; the pending update is dropped, not replayed.
/// - **Back to health** — immediate. Recovery is the one transition nobody
///   needs protecting from, and delaying it would leave a stale alarm on screen
///   after the connection is demonstrably fine.
/// - **Trouble to different trouble** — immediate. Once the treatment is on
///   screen its details (the reconnect attempt counter, a stall that becomes a
///   drop) refine live rather than freezing at whatever landed first.
///
/// The window is measured from the FIRST reading that broke health. Trouble
/// arriving while a hold is already running only updates what that hold will
/// publish — a reconnect loop bumping its attempt counter every second must not
/// be able to defer the treatment indefinitely by restarting the clock.
@MainActor
final class ConnectionSettler {
    /// How long trouble must persist before the UI shows it.
    ///
    /// Sized against the reconnect budget rather than picked round: the first
    /// attempt only fires after `ReconnectBackoff.baseDelay`, and then needs a
    /// signaling round trip and an ICE handshake to land. A hold at or under
    /// that base delay would expire while the blip it exists to hide is still
    /// healing — every drop would flash the treatment anyway.
    static let holdDuration: Duration = .seconds(2)

    /// The value the UI reads.
    private(set) var settled: ConnectionHealth

    /// Called whenever `settled` changes. Set by the owner; never fires with an
    /// unchanged value.
    var onChange: ((ConnectionHealth) -> Void)?

    private let holdDuration: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    /// The running hold, and the trouble it will publish when it expires.
    private var hold: Task<Void, Never>?
    private var pending: ConnectionHealth?

    /// - Parameters:
    ///   - initial: Where the app starts. Trouble here is published as-is —
    ///     there is no healthy state to protect, and a launch that begins
    ///     disconnected must say so immediately.
    ///   - holdDuration: Overridable so tests do not spend real seconds.
    ///   - sleep: Injectable so tests drive the hold deterministically.
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

    /// Feed the raw transport state. Publishes immediately or after the hold,
    /// per the rules above.
    func ingest(_ raw: ConnectionHealth) {
        guard !raw.isHealthy, settled.isHealthy else {
            // Recovery, or a refinement of trouble already on screen. Either
            // way there is nothing left to protect the user from, and any
            // pending hold is stale — including the blip case, where the
            // reading that cancels it is the one already on screen.
            cancelHold()
            guard raw != settled else { return }
            publish(raw)
            return
        }

        pending = raw
        // An in-flight window keeps its own deadline; only its payload moves.
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

    /// Publish `raw` now, dropping any hold. The UI-test hooks pin a state that
    /// no transport produced, so they need the treatment on screen at once
    /// rather than a window later.
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
