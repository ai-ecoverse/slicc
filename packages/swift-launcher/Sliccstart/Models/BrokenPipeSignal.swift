import Darwin

/// Process-wide SIGPIPE policy (#3418).
///
/// The default SIGPIPE action kills the process without a crash report, so any
/// write to a socket or pipe whose peer is gone ends the menu-bar app silently.
/// URLSession and Network.framework set `SO_NOSIGPIPE` on their own sockets,
/// but raw sockets (libwebrtc) and the stdio pipes do not. With the signal
/// ignored, such a write fails with `EPIPE` and the caller handles the error.
enum BrokenPipeSignal {
    /// Ignore SIGPIPE for the whole process. Call first thing in `main`.
    @discardableResult
    static func ignore() -> Bool {
        address(of: signal(SIGPIPE, SIG_IGN)) != address(of: SIG_ERR)
    }

    /// Whether the current SIGPIPE disposition is `SIG_IGN`.
    static var isIgnored: Bool {
        var current = sigaction()
        guard sigaction(SIGPIPE, nil, &current) == 0 else { return false }
        return address(of: current.__sigaction_u.__sa_handler) == address(of: SIG_IGN)
    }

    // C function pointers are not Equatable in Swift; compare their addresses.
    private static func address(of handler: sig_t?) -> Int {
        unsafeBitCast(handler, to: Int.self)
    }
}
