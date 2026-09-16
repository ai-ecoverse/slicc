import Foundation

public final class Optel: @unchecked Sendable {

    public static let shared = Optel()

    private let lock = NSLock()
    private var appID: String = ""
    private var collectBaseURL: URL = RUMReferer.defaultCollectBaseURL
    private var session: SamplingSession?
    private var collector: OptelCollector?
    private var sessionStart: Date = Date()
    private var hasEmittedTop: Bool = false

    public init() {}

    public func configure(
        appID: String,
        rate: String? = nil,
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL,
        transport: OptelTransport? = nil,
        randomSource: RandomSource? = nil
    ) {
        configure(
            appID: appID,
            rate: rate,
            collectBaseURL: collectBaseURL,
            transport: transport,
            randomSource: randomSource,
            environment: ProcessInfo.processInfo.environment
        )
    }

    internal func configure(
        appID: String,
        rate: String?,
        collectBaseURL: URL,
        transport: OptelTransport?,
        randomSource: RandomSource?,
        environment: [String: String]
    ) {
        let resolvedRate = OptelEnvConfig.resolveRate(explicit: rate, environment: environment)
        let debugLogging = OptelEnvConfig.resolveDebugLogging(environment: environment)
        let config = SamplingConfig(rate: resolvedRate)
        let id = RUMSessionID.generate()
        let resolvedRandom = randomSource ?? SystemRandomSource()
        let newSession = SamplingSession(id: id, config: config, random: resolvedRandom)
        let resolvedTransport = transport ?? URLSessionOptelTransport(debugLogging: debugLogging)
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

    public func sample(
        _ checkpoint: RUMCheckpoint,
        source: String? = nil,
        target: String? = nil,
        value: Double? = nil
    ) {

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

    public static func configure(
        appID: String,
        rate: String? = nil,
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL
    ) {
        shared.configure(appID: appID, rate: rate, collectBaseURL: collectBaseURL)
    }

    public static func sample(
        _ checkpoint: RUMCheckpoint,
        source: String? = nil,
        target: String? = nil,
        value: Double? = nil
    ) {
        shared.sample(checkpoint, source: source, target: target, value: value)
    }
}
