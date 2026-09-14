import Foundation


























actor DataChannelKeepalive {
    private let sendPing: @Sendable () -> Void
    private let onDead: @Sendable () -> Void
    private let isTransportOpen: @Sendable () -> Bool
    private let onStalled: (@Sendable () -> Void)?
    private let onRecovered: (@Sendable () -> Void)?

    
    private let pingInterval: TimeInterval

    
    private let maxMissed: Int

    
    
    
    
    private let hardMaxMissed: Int

    private var pingTask: Task<Void, Never>?
    private var missedPongs: Int = 0
    private var awaitingPong: Bool = false
    private var stopped: Bool = false
    private var stalled: Bool = false

    
    
    
    
    
    
    
    
    
    
    
    
    
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

    
    
    
    
    func stop() {
        stopped = true
        stalled = false
        pingTask?.cancel()
        pingTask = nil
    }

    
    func receivedPong() {
        guard !stopped else { return }
        awaitingPong = false
        missedPongs = 0
        clearStall()
    }

    
    
    
    
    func receivedPing() {
        guard !stopped else { return }
        missedPongs = 0
        awaitingPong = false
        clearStall()
    }

    
    var missed: Int { missedPongs }

    
    var isStalled: Bool { stalled }

    
    
    func tick() {
        guard !stopped else { return }

        if awaitingPong {
            missedPongs += 1
            if missedPongs >= maxMissed && declareUnreachable() { return }
        }

        awaitingPong = true
        sendPing()
    }

    

    private func clearStall() {
        guard stalled else { return }
        stalled = false
        onRecovered?()
    }

    
    
    private func declareUnreachable() -> Bool {
        
        
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
