import AppKit
import Darwin
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ComputerFollowCLI")

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
    private static func runPreflight(json: Bool) -> Int32 {
        NSApplication.shared.setActivationPolicy(.accessory)
        let grants = ComputerFollowCLI.resolveGrants(using: .live)
        do {
            FileHandle.standardOutput.write(try ComputerFollowCLI.report(grants, json: json))
        } catch {
            log.error("encode failed: \(error.localizedDescription, privacy: .public)")
            FileHandle.standardError.write(
                Data("Sliccstart: failed to encode permission state\n".utf8))
            return 1
        }
        return ComputerFollowCLI.exitCode(for: grants)
    }

    /// Dial one leader as a computer-only follower and stay there.
    ///
    /// Never returns under normal operation: the CLI that spawned this process
    /// owns its lifetime and ends it with SIGTERM (or by dying, which closes
    /// our stdout).
    private static func runFollow(joinUrl: String, pairId: String?) -> Int32 {
        let app = NSApplication.shared
        // `.accessory`: no Dock tile, no menu bar, no windows — but still a GUI
        // app as far as TCC and ScreenCaptureKit are concerned. `.prohibited`
        // would suppress the permission prompts this whole detour exists for.
        app.setActivationPolicy(.accessory)

        let follower = MainActor.assumeIsolated { ComputerTrayFollower(pairId: pairId) }
        MainActor.assumeIsolated { follower.leaderChanged(joinUrl: joinUrl) }

        installTerminationHandlers(follower)

        // Only after the follower is wired: the CLI treats this line as "the
        // launcher understood the flag", and printing it earlier would make a
        // failure to attach look like a healthy start.
        print(ComputerFollowCLI.readyLine)
        fflush(stdout)
        log.info("Headless computer follower attached")

        app.run()
        return 0
    }

    /// Stop the follower on SIGTERM/SIGINT so the leader sees a clean departure
    /// instead of keeping a dead roster entry until keepalive times it out.
    ///
    /// `signal(…, SIG_IGN)` first because a `DispatchSource` signal handler is
    /// additive to the default disposition, and the default for both of these
    /// is to kill the process before the source ever fires.
    private static func installTerminationHandlers(_ follower: ComputerTrayFollower) {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated { follower.stop() }
                log.info("Headless computer follower stopping on signal")
                exit(0)
            }
            source.resume()
            // Retained for the process's lifetime; a cancelled source would
            // restore the default disposition and turn the next signal fatal.
            signalSources.append(source)
        }
    }
}

/// Signal sources are only live while referenced.
private nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
