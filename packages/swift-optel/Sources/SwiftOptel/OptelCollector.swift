import Foundation









public final class OptelCollector: @unchecked Sendable {
    private let transport: OptelTransport
    private let collectBaseURL: URL
    private let queueLimit: Int
    private let lock = NSLock()
    private var buffered: [RUMEvent] = []
    private var session: SamplingSession?

    
    
    
    
    
    
    
    
    
    public init(
        transport: OptelTransport = URLSessionOptelTransport(),
        collectBaseURL: URL = RUMReferer.defaultCollectBaseURL,
        queueLimit: Int = 256
    ) {
        self.transport = transport
        self.collectBaseURL = collectBaseURL
        self.queueLimit = max(0, queueLimit)
    }

    
    public var bufferedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return buffered.count
    }

    
    public var hasSession: Bool {
        lock.lock()
        defer { lock.unlock() }
        return session != nil
    }

    
    
    
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
            
            
            buffered.removeFirst(buffered.count - queueLimit)
        }
        lock.unlock()
    }

    
    
    
    
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
