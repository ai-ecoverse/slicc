import Darwin








enum BrokenPipeSignal {
    
    @discardableResult
    static func ignore() -> Bool {
        address(of: signal(SIGPIPE, SIG_IGN)) != address(of: SIG_ERR)
    }

    
    static var isIgnored: Bool {
        var current = sigaction()
        guard sigaction(SIGPIPE, nil, &current) == 0 else { return false }
        return address(of: current.__sigaction_u.__sa_handler) == address(of: SIG_IGN)
    }

    
    private static func address(of handler: sig_t?) -> Int {
        unsafeBitCast(handler, to: Int.self)
    }
}
