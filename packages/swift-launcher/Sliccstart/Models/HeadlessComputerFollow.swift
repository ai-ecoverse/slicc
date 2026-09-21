import Foundation

/// The behaviour of `Sliccstart --computer-follow`, with its two side effects —
/// writing a protocol line and ending the process — injected.
///
/// ``ComputerFollowCLIRunner`` owns what cannot run in a test bundle
/// (`NSApplication`, the run loop, signal and kqueue sources) and forwards every
/// event here, so the rules the `slicc` CLI depends on are tested directly:
/// ready before any network work, attached only once `hello` is out, and every
/// ending — give-up, signal, dead parent — stopping the follower first so the
/// leader sees a departure instead of a stale roster entry.
@MainActor
final class HeadlessComputerFollow {
    private let follower: ComputerTrayFollower
    private let emit: (String) -> Void
    private let terminate: (Int32) -> Void
    private var reporter = ComputerFollowCLI.AttachReporter()

    /// - Parameters:
    ///   - emit: writes one protocol line and flushes it (the CLI reads stdout
    ///     line by line, so a buffered line can sit there while its timeout runs).
    ///   - terminate: ends the process with the status; `exit` in production.
    init(
        follower: ComputerTrayFollower,
        emit: @escaping (String) -> Void,
        terminate: @escaping (Int32) -> Void
    ) {
        self.follower = follower
        self.emit = emit
        self.terminate = terminate
    }

    func start(joinUrl: String) {
        // "I understand the flag" — before any network work, so the CLI can
        // tell an outdated launcher from an unreachable leader. Attachment is
        // reported separately, from the follower's own callbacks.
        emit(ComputerFollowCLI.readyLine)
        follower.onConnected = { [weak self] in
            guard let self else { return }
            self.perform(self.reporter.connected())
        }
        follower.onGaveUp = { [weak self] reason in
            guard let self else { return }
            self.follower.stop()
            self.perform(self.reporter.gaveUp(reason))
        }
        follower.leaderChanged(joinUrl: joinUrl)
    }

    /// SIGTERM / SIGINT from the CLI: the ordinary way this process ends.
    func signalled() { end(status: 0) }

    /// The spawning CLI is gone — SIGKILLed or crashed, so its SIGTERM never
    /// came. Staying up would leave the leader able to capture the screen after
    /// the user believes the session ended.
    func parentExited() { end(status: 0) }

    private func end(status: Int32) {
        follower.stop()
        terminate(status)
    }

    private func perform(_ action: ComputerFollowCLI.AttachReporter.Action) {
        switch action {
        case .none:
            return
        case .print(let line):
            emit(line)
        case .printAndExit(let line, let status):
            emit(line)
            terminate(status)
        }
    }
}
