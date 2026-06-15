import Foundation

/// Configured entry point for the SwiftOptel client, mirroring the
/// `sampleRUM(checkpoint, data)` surface from `helix-rum-js`.
///
/// Lifecycle:
/// 1. Call ``configure(appID:rate:collectBaseURL:transport:randomSource:)`` once
///    at app launch. This resolves a ``SamplingConfig`` from `rate`, derives a
///    fresh session id, computes the once-per-session selection decision, and
///    attaches an ``OptelCollector`` to the chosen ``OptelTransport``.
/// 2. Call ``sample(_:source:target:value:)`` from anywhere; the first call
///    automatically emits a `top` ping (matching helix-rum-js
///    `sampleRUM.sendPing('top', 0)`), then the caller's checkpoint.
///
/// All mutating state is guarded by an `NSLock` so concurrent producers are
/// safe. Re-calling ``configure`` resets the session, sampling decision,
/// `top` flag, and start time.
public final class Optel: @unchecked Sendable {
    /// Shared singleton used by the static convenience methods. Callers may
    /// instantiate their own ``Optel`` if they need isolated state (tests).
    public static let shared = Optel()

    private let lock = NSLock()
    private var appID: String = ""
    private var collectBaseURL: URL = RUMReferer.defaultCollectBaseURL
    private var session: SamplingSession?
    private var collector: OptelCollector?
    private var sessionStart: Date = Date()
    private var hasEmittedTop: Bool = false

    public init() {}

    /// Configure (or reconfigure) the client.
    ///
    /// - Parameters:
    ///   - appID: Identifier used as the `referer` hostname (e.g. bundle id).
    ///   - rate: Sampling rate string. Only the `on`/`off`/`high`/`low`
    ///     aliases are recognized; `nil` and every other value (including
    ///     numeric strings) fall back to the helix-rum-js default of `100`.
    ///   - collectBaseURL: Collector base URL. Defaults to `rum.hlx.page`.
    ///   - transport: Override the default ``URLSessionOptelTransport``
    ///     (tests inject a mock here).
    ///   - randomSource: Override the system RNG used to compute
    ///     `isSelected` (tests pin this for determinism).
    public func configure(
        appID: String,
        rate: String? = nil,
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL,
        transport: OptelTransport? = nil,
        randomSource: RandomSource? = nil
    ) {
        let config = SamplingConfig(rate: rate)
        let id = RUMSessionID.generate()
        let resolvedRandom = randomSource ?? SystemRandomSource()
        let newSession = SamplingSession(id: id, config: config, random: resolvedRandom)
        let resolvedTransport = transport ?? URLSessionOptelTransport()
        let newCollector = OptelCollector(
            transport: resolvedTransport,
            collectBaseURL: collectBaseURL
        )
        newCollector.attach(session: newSession)

        lock.lock()
        self.appID = appID
        self.collectBaseURL = collectBaseURL
        self.session = newSession
        self.collector = newCollector
        self.sessionStart = Date()
        self.hasEmittedTop = false
        lock.unlock()
    }

    /// Sample a checkpoint. Mirrors `sampleRUM(checkpoint, { source, target, value })`.
    ///
    /// The first invocation after ``configure(appID:rate:collectBaseURL:transport:randomSource:)``
    /// emits an auto-`top` beacon with `t=0`, then the caller's checkpoint.
    /// If the caller's checkpoint is itself `.top`, the two are folded into a
    /// single beacon so the user's payload still reaches the wire and the
    /// `top` is not duplicated.
    public func sample(
        _ checkpoint: RUMCheckpoint,
        source: String? = nil,
        target: String? = nil,
        value: Double? = nil
    ) {
        // Hold the lock across both `enqueue` calls so concurrent first-callers
        // cannot interleave between flipping `hasEmittedTop` and enqueuing the
        // auto-`top` beacon. `OptelCollector.enqueue` takes its own independent
        // lock and never re-enters `Optel`, so this cannot deadlock.
        lock.lock()
        defer { lock.unlock() }
        guard let session = session, let collector = collector else {
            return
        }
        let weight = session.weight
        let id = session.id
        let referer = RUMReferer.build(appID: appID, viewPath: "/")
        let timeShift = max(0, Int(Date().timeIntervalSince(sessionStart) * 1000))
        let isFirst = !hasEmittedTop
        if isFirst { hasEmittedTop = true }

        let isTopRequest = checkpoint == .top
        if isFirst && !isTopRequest {
            collector.enqueue(
                RUMEvent(
                    weight: weight,
                    id: id,
                    referer: referer,
                    checkpoint: .top,
                    t: 0
                )
            )
        }
        let pingData = RUMPingData(source: source, target: target, value: value)
        collector.enqueue(
            RUMEvent(
                weight: weight,
                id: id,
                referer: referer,
                checkpoint: checkpoint,
                t: isFirst && isTopRequest ? 0 : timeShift,
                pingData: pingData
            )
        )
    }

    /// Static convenience: configure the shared singleton.
    public static func configure(
        appID: String,
        rate: String? = nil,
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL
    ) {
        shared.configure(appID: appID, rate: rate, collectBaseURL: collectBaseURL)
    }

    /// Static convenience: sample on the shared singleton.
    public static func sample(
        _ checkpoint: RUMCheckpoint,
        source: String? = nil,
        target: String? = nil,
        value: Double? = nil
    ) {
        shared.sample(checkpoint, source: source, target: target, value: value)
    }
}
