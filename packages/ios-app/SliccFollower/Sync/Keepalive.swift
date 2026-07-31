import Foundation

/// Manages ping/pong keepalive over a tray data channel.
///
/// Missing `maxMissed` consecutive pongs means the peer is not *answering*,
/// which is not the same thing as the peer being gone. Both ends of the tray
/// sync channel run this timer on the same thread that serves the agent, so a
/// peer that is merely CPU-starved (the hosted-leader float shares one small
/// sandbox between Chromium, the kernel worker, and node-server) stops
/// answering pings long before its transport dies. Treating that as death tore
/// down a healthy connection and forced a full ICE/DTLS renegotiation — the
/// disconnect was self-inflicted.
///
/// So the state machine has two thresholds:
///
/// - `maxMissed` consecutive misses → **stalled**. Reported once via
///   `onStalled`; the timer keeps probing and `onRecovered` fires when the peer
///   answers again. No teardown.
/// - `hardMaxMissed` consecutive misses → **dead**. `onDead` fires and the
///   keepalive stops, exactly as before.
///
/// The stall state only applies while `isTransportOpen` says the underlying
/// channel is still usable. It defaults to `{ false }`, so a caller that does
/// not pass it keeps the original "dead at `maxMissed`" behavior.
///
/// Port of `DataChannelKeepalive` from
/// `packages/webapp/src/scoops/data-channel-keepalive.ts`.
actor DataChannelKeepalive {
    private let sendPing: @Sendable () -> Void
    private let onDead: @Sendable () -> Void
    private let isTransportOpen: @Sendable () -> Bool
    private let onStalled: (@Sendable () -> Void)?
    private let onRecovered: (@Sendable () -> Void)?

    /// Ping interval in seconds (TS default: 10_000 ms → 10 s).
    private let pingInterval: TimeInterval

    /// Number of consecutive missed pongs before reporting a stall (TS default: 3).
    private let maxMissed: Int

    /// Consecutive missed pongs before declaring the peer dead even though its
    /// transport still looks open (TS default: 30 — five minutes at the default
    /// interval). Only consulted while `isTransportOpen` returns true; a closed
    /// transport still dies at `maxMissed`.
    private let hardMaxMissed: Int

    private var pingTask: Task<Void, Never>?
    private var missedPongs: Int = 0
    private var awaitingPong: Bool = false
    private var stopped: Bool = false
    private var stalled: Bool = false

    /// Creates a new keepalive timer.
    ///
    /// - Parameters:
    ///   - sendPing: Closure that sends a `ping` message over the data channel.
    ///   - onDead: Closure called when the remote side is considered dead.
    ///   - isTransportOpen: Whether the channel still looks usable. While this
    ///     returns true, crossing `maxMissed` reports a stall instead of death.
    ///   - onStalled: Called once when the peer crosses `maxMissed` with the
    ///     transport still open.
    ///   - onRecovered: Called once when a stalled peer answers again.
    ///   - pingInterval: Seconds between pings (default 10, matching the TS 10 000 ms).
    ///   - maxMissed: Consecutive missed pongs before reporting a stall (default 3).
    ///   - hardMaxMissed: Consecutive missed pongs before declaring death (default 30).
    init(
        sendPing: @escaping @Sendable () -> Void,
        onDead: @escaping @Sendable () -> Void,
        isTransportOpen: @escaping @Sendable () -> Bool = { false },
        onStalled: (@Sendable () -> Void)? = nil,
        onRecovered: (@Sendable () -> Void)? = nil,
        pingInterval: TimeInterval = 10,
        maxMissed: Int = 3,
        hardMaxMissed: Int = 30
    ) {
        precondition(pingInterval > 0, "pingInterval must be positive; got \(pingInterval)")
        precondition(maxMissed >= 1, "maxMissed must be a positive integer; got \(maxMissed)")
        // `tick` only consults the hard deadline after `maxMissed` is crossed, so
        // a hard deadline below the soft one would silently never apply — death
        // would land at `maxMissed` instead, later than the configured hard
        // deadline promises. Reject the contradiction rather than surprising the
        // caller with a threshold that quietly does nothing.
        precondition(
            hardMaxMissed >= maxMissed,
            "hardMaxMissed (\(hardMaxMissed)) must be >= maxMissed (\(maxMissed))")

        self.sendPing = sendPing
        self.onDead = onDead
        self.isTransportOpen = isTransportOpen
        self.onStalled = onStalled
        self.onRecovered = onRecovered
        self.pingInterval = pingInterval
        self.maxMissed = maxMissed
        self.hardMaxMissed = hardMaxMissed
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
    ///
    /// Terminal: any stall is cleared without notifying, so a late pong cannot
    /// report a recovery for a state machine that has already given up.
    func stop() {
        stopped = true
        stalled = false
        pingTask?.cancel()
        pingTask = nil
    }

    /// Call when a pong is received from the remote side — resets the missed counter.
    func receivedPong() {
        guard !stopped else { return }
        awaitingPong = false
        missedPongs = 0
        clearStall()
    }

    /// Call when a ping is received from the remote side.
    ///
    /// Receiving a ping also proves the channel is alive, so counters are reset.
    /// The caller is responsible for sending a pong back.
    func receivedPing() {
        guard !stopped else { return }
        missedPongs = 0
        awaitingPong = false
        clearStall()
    }

    /// The current number of consecutive missed pongs (exposed for testing).
    var missed: Int { missedPongs }

    /// Whether the peer is currently past `maxMissed` but still reachable.
    var isStalled: Bool { stalled }

    /// One keepalive interval. Internal rather than private so tests can drive
    /// the state machine deterministically instead of waiting on wall clock.
    func tick() {
        guard !stopped else { return }

        if awaitingPong {
            missedPongs += 1
            if missedPongs >= maxMissed && declareUnreachable() { return }
        }

        awaitingPong = true
        sendPing()
    }

    // MARK: - Private

    private func clearStall() {
        guard stalled else { return }
        stalled = false
        onRecovered?()
    }

    /// Decide what crossing `maxMissed` means. Returns true when the keepalive
    /// has died and `tick` must not send another ping.
    private func declareUnreachable() -> Bool {
        // A peer we can still reach is busy, not gone — keep probing until the
        // hard deadline rather than tearing down a working transport.
        if missedPongs < hardMaxMissed && isTransportOpen() {
            if !stalled {
                stalled = true
                onStalled?()
            }
            return false
        }
        stop()
        onDead()
        return true
    }
}
