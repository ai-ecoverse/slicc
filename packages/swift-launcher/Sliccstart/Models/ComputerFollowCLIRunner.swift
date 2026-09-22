import AppKit
import Darwin
import Foundation

/// Thin, side-effecting glue for the headless computer modes. Every decision
/// lives in the pure ``ComputerFollowCLI``; this file is deliberately small
/// because it cannot be unit-tested (AppKit, TCC, a live WebRTC leader).
enum ComputerFollowCLIRunner {
    static func run(_ request: ComputerFollowCLI.Request) -> Int32 {
        switch request {
        case .preflight(let json):
            return runPreflight(json: json)
        case .follow(let joinUrl, let pairId):
            return runFollow(joinUrl: joinUrl, pairId: pairId)
        }
    }

    /// Raise both prompts, then report. Runs as an `.accessory` app because a
    /// TCC prompt needs a GUI session to appear in — a plain `Foundation`
    /// process would have `CGRequestScreenCaptureAccess` return false with no
    /// dialog and the user would be told they denied something they never saw.
    ///
    /// Which is also why running `Sliccstart --computer-preflight --json` by hand
    /// from a shell is not a diagnostic: TCC attributes the check to the
    /// *responsible* process — the terminal, not this bundle — so it answers
    /// `{"accessibility":false,"screenRecording":false}` and draws nothing on a
    /// fully granted Mac. Only the Go CLI's spawn reports this machine's grants.
    private static func runPreflight(json: Bool) -> Int32 {
        NSApplication.shared.setActivationPolicy(.accessory)
        return ComputerFollowCLI.preflight(
            using: .live, json: json,
            writeOut: { FileHandle.standardOutput.write($0) },
            writeErr: { FileHandle.standardError.write($0) })
    }

    /// Dial one leader as a computer-only follower and stay there.
    ///
    /// Never returns under normal operation. Every decision is in
    /// ``HeadlessComputerFollow``; this only supplies the process-level effects
    /// and the event sources that feed it.
    private static func runFollow(joinUrl: String, pairId: String?) -> Int32 {
        let app = NSApplication.shared
        // `.accessory`: no Dock tile, no menu bar, no windows — but still a GUI
        // app as far as TCC and ScreenCaptureKit are concerned. `.prohibited`
        // would suppress the permission prompts this whole detour exists for.
        app.setActivationPolicy(.accessory)

        let session = MainActor.assumeIsolated {
            let session = HeadlessComputerFollow(
                follower: ComputerTrayFollower(pairId: pairId),
                emit: { line in
                    print(line)
                    fflush(stdout)
                },
                terminate: { status in exit(status) })
            session.start(joinUrl: joinUrl)
            return session
        }

        installTerminationHandlers(session)
        watchParent(session)

        app.run()
        return 0
    }

    /// `signal(…, SIG_IGN)` first because a `DispatchSource` signal handler is
    /// additive to the default disposition, and the default for both of these
    /// is to kill the process before the source ever fires.
    private static func installTerminationHandlers(_ session: HeadlessComputerFollow) {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { session.signalled() } }
            source.resume()
            // Retained for the process's lifetime; a cancelled source would
            // restore the default disposition and turn the next signal fatal.
            signalSources.append(source)
        }
    }

    /// Exit when the spawning CLI does, however it goes: its deferred SIGTERM
    /// never runs after a SIGKILL or a crash, and closing the stdout pipe does
    /// not end a process that never writes to it again. A kqueue process source
    /// fires on the parent's exit without polling.
    private static func watchParent(_ session: HeadlessComputerFollow) {
        let parent = getppid()
        // Already gone: launchd adopted us before the source could be armed, so
        // it would never fire.
        guard !ComputerFollowCLI.parentIsGone(parentPid: parent) else {
            MainActor.assumeIsolated { session.parentExited() }
            return
        }
        let source = DispatchSource.makeProcessSource(
            identifier: parent, eventMask: .exit, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { session.parentExited() } }
        source.resume()
        parentSource = source
        // Closes the window between getppid() and resume(): an exit in it raises
        // no event on a source that did not exist yet.
        if ComputerFollowCLI.parentIsGone(parentPid: getppid()) {
            MainActor.assumeIsolated { session.parentExited() }
        }
    }
}

/// Dispatch sources are only live while referenced.
private nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
private nonisolated(unsafe) var parentSource: DispatchSourceProcess?
