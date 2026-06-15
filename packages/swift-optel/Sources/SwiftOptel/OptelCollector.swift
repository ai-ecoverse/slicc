import Foundation

/// Session-aware buffer that holds RUM events until the sampling decision is
/// known, then either flushes them through the configured transport or drops
/// them entirely.
///
/// Behavior matches helix-rum-js: events generated before sampling has been
/// resolved are queued; once a ``SamplingSession`` is attached, selected
/// sessions flush the backlog and forward new events, while unselected
/// sessions discard everything.
public final class OptelCollector: @unchecked Sendable {
    private let transport: OptelTransport
    private let collectBaseURL: URL
    private let queueLimit: Int
    private let lock = NSLock()
    private var buffered: [RUMEvent] = []
    private var session: SamplingSession?

    /// Construct a collector.
    ///
    /// - Parameters:
    ///   - transport: Beacon sender. Defaults to ``URLSessionOptelTransport``.
    ///   - collectBaseURL: Collector base URL.
    ///     Defaults to `https://rum.hlx.page/`.
    ///   - queueLimit: Maximum number of events to buffer while waiting for
    ///     the sampling decision. Older events are dropped on overflow so a
    ///     stuck session cannot grow unbounded.
    public init(
        transport: OptelTransport = URLSessionOptelTransport(),
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL,
        queueLimit: Int = 256
    ) {
        self.transport = transport
        self.collectBaseURL = collectBaseURL
        self.queueLimit = max(0, queueLimit)
    }

    /// Snapshot of currently buffered events. Test/debug aid.
    public var bufferedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return buffered.count
    }

    /// Whether a sampling session has been attached.
    public var hasSession: Bool {
        lock.lock(); defer { lock.unlock() }
        return session != nil
    }

    /// Enqueue an event. Forwarded immediately if the session is selected,
    /// dropped if the session is unselected, otherwise buffered until
    /// ``attach(session:)`` is called.
    public func enqueue(_ event: RUMEvent) {
        lock.lock()
        if let current = session {
            lock.unlock()
            if current.isSelected {
                transport.send(event, collectBaseURL: collectBaseURL)
            }
            return
        }
        buffered.append(event)
        if buffered.count > queueLimit {
            // Drop the oldest entries to bound memory while waiting for the
            // sampling decision. Matches the "best-effort" nature of beacons.
            buffered.removeFirst(buffered.count - queueLimit)
        }
        lock.unlock()
    }

    /// Attach the resolved sampling session and flush the backlog.
    ///
    /// Calling this more than once is a no-op after the first call so the
    /// queue cannot be double-flushed.
    public func attach(session newSession: SamplingSession) {
        lock.lock()
        guard session == nil else {
            lock.unlock()
            return
        }
        session = newSession
        let pending = buffered
        buffered.removeAll(keepingCapacity: false)
        lock.unlock()

        guard newSession.isSelected else { return }
        for event in pending {
            transport.send(event, collectBaseURL: collectBaseURL)
        }
    }
}
