import Foundation

/// Manages ping/pong keepalive over a tray data channel.
///
/// Sends periodic pings and declares the connection dead if no pong (or ping)
/// is received within `maxMissed` consecutive intervals.
///
/// Port of `DataChannelKeepalive` from
/// `packages/webapp/src/scoops/data-channel-keepalive.ts`.
actor DataChannelKeepalive {
    private let sendPing: @Sendable () -> Void
    private let onDead: @Sendable () -> Void

    /// Ping interval in seconds (TS default: 10_000 ms → 10 s).
    private let pingInterval: TimeInterval

    /// Number of consecutive missed pongs before declaring dead (TS default: 3).
    private let maxMissed: Int

    private var pingTask: Task<Void, Never>?
    private var missedPongs: Int = 0
    private var awaitingPong: Bool = false
    private var stopped: Bool = false

    /// Creates a new keepalive timer.
    ///
    /// - Parameters:
    ///   - sendPing: Closure that sends a `ping` message over the data channel.
    ///   - onDead: Closure called when the remote side is considered dead.
    ///   - pingInterval: Seconds between pings (default 10, matching the TS 10 000 ms).
    ///   - maxMissed: Consecutive missed pongs before declaring dead (default 3).
    init(
        sendPing: @escaping @Sendable () -> Void,
        onDead: @escaping @Sendable () -> Void,
        pingInterval: TimeInterval = 10,
        maxMissed: Int = 3
    ) {
        self.sendPing = sendPing
        self.onDead = onDead
        self.pingInterval = pingInterval
        self.maxMissed = maxMissed
    }

    /// Start the keepalive interval. Safe to call multiple times.
    func start() {
        guard pingTask == nil, !stopped else { return }
        pingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(await self.pingInterval * 1_000_000_000))
                if Task.isCancelled { break }
                await self.tick()
            }
        }
    }

    /// Stop the keepalive. Once stopped it cannot be restarted.
    func stop() {
        stopped = true
        pingTask?.cancel()
        pingTask = nil
    }

    /// Call when a pong is received from the remote side — resets the missed counter.
    func receivedPong() {
        awaitingPong = false
        missedPongs = 0
    }

    /// Call when a ping is received from the remote side.
    ///
    /// Receiving a ping also proves the channel is alive, so counters are reset.
    /// The caller is responsible for sending a pong back.
    func receivedPing() {
        missedPongs = 0
        awaitingPong = false
    }

    /// The current number of consecutive missed pongs (exposed for testing).
    var missed: Int { missedPongs }

    // MARK: - Private

    private func tick() {
        guard !stopped else { return }

        if awaitingPong {
            missedPongs += 1
            if missedPongs >= maxMissed {
                stop()
                onDead()
                return
            }
        }

        awaitingPong = true
        sendPing()
    }
}

