import Darwin

/// Process-wide SIGPIPE policy (#3418).
///
/// The default SIGPIPE action kills the process without a crash report.
/// Sliccstart wires this server's stdout/stderr to pipes; once the launcher
/// quits, the next log line would raise SIGPIPE and take the server down with
/// it. SwiftNIO sets `SO_NOSIGPIPE` on its own sockets, but stdio pipes and raw
/// libwebrtc sockets are not covered. With the signal ignored, such a write
/// fails with `EPIPE` and the server keeps serving.
enum BrokenPipeSignal {
    /// Ignore SIGPIPE for the whole process. Call before anything writes to stdio or a socket.
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
