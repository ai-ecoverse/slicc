import Darwin
import Foundation
import XCTest
@testable import Sliccstart

/// Pins the safety boundary on `SwiftLMProcess`'s orphan-reclaim path.
///
/// History: when the parent Sliccstart is killed with SIGKILL (crash,
/// `pkill -9`, panic), `applicationWillTerminate` does not fire and
/// `Process.terminate()` never reaches the SwiftLM child — launchd
/// reparents the child, which keeps holding port 5413, and the next
/// "Run" click hits "Port 5413 is already in use." `reclaimOurOrphans`
/// exists to handle that: it identifies SwiftLM children whose binary
/// path matches our installer's, sends them SIGTERM (then SIGKILL if
/// stubborn), and lets `start()` retry.
///
/// The hazard is killing the *wrong* process. A user could have a
/// Foreman dev server, a Python REPL, or any other app bound to 5413,
/// and we must never SIGTERM a stranger. These tests pin the
/// "ours vs. not ours" predicate using the running test runner itself
/// — `getpid()` is guaranteed to be a real process whose binary path
/// is *not* `~/.slicc/SwiftLM/<version>/SwiftLM`.
final class SwiftLMOrphanReclaimTests: XCTestCase {

    /// `proc_pidpath` should resolve the test runner's own binary
    /// to a real path. If this returns `nil`, the syscall is broken
    /// (or the entitlement story changed) and the predicate becomes
    /// useless — fail loudly so the regression is obvious.
    func testExecutablePathResolvesForCurrentProcess() {
        let path = SwiftLMProcess.executablePath(forPID: getpid())
        XCTAssertNotNil(path)
        XCTAssertFalse(path?.isEmpty ?? true)
        // The runner is some xctest binary; we don't pin the exact
        // path (it varies across SPM/xcodebuild/CI) — only that it's
        // a real absolute path.
        XCTAssertEqual(path?.first, "/")
    }

    /// PID 1 (launchd) on macOS is `/sbin/launchd`, never our SwiftLM.
    /// Keeps the predicate honest about a known foreign process.
    func testExecutablePathForLaunchdIsNotOurs() {
        let path = SwiftLMProcess.executablePath(forPID: 1)
        // We don't get launchd's path on every host (sandboxed runners
        // can refuse), so accept either result, but if we DO get a
        // path it must not match a SwiftLM-shaped one.
        if let path {
            XCTAssertFalse(path.hasSuffix("/SwiftLM"))
        }
    }

    /// `executablePath(forPID:)` for an obviously dead PID returns nil.
    /// `kill(<huge>, 0)` returns ESRCH; `proc_pidpath` likewise fails.
    func testExecutablePathForDeadPIDIsNil() {
        // PIDs are 32-bit on macOS but never approach Int32.max in
        // practice; pick a value that won't be in use.
        let likelyDead: pid_t = 0x7FFF_FFF0
        XCTAssertNil(SwiftLMProcess.executablePath(forPID: likelyDead))
    }

    // MARK: - The actual safety predicate

    /// **Core safety property.** The current test runner is some xctest
    /// binary, which is guaranteed *not* to be our SwiftLM binary.
    /// `isOurOrphanedSwiftLM(pid: getpid(), ourBinaryPath: <ours>)`
    /// must return `false`, no matter what we pass for `ourBinaryPath`.
    /// If this ever flips to `true` we'd be SIGTERMing the wrong PID.
    func testRunnerIsNotMistakenForOurSwiftLM() {
        let pretendOurs = "/Users/nobody/.slicc/SwiftLM/b602/SwiftLM"
        XCTAssertFalse(
            SwiftLMProcess.isOurOrphanedSwiftLM(pid: getpid(), ourBinaryPath: pretendOurs)
        )
    }

    /// Pins that an empty `ourBinaryPath` (e.g. installer never ran)
    /// fails-closed: we refuse to kill anything until the caller has
    /// a concrete path to match against.
    func testEmptyOurPathBlocksReclaim() {
        XCTAssertFalse(
            SwiftLMProcess.isOurOrphanedSwiftLM(pid: getpid(), ourBinaryPath: "")
        )
    }

    /// Pins that a *different* binary at a SwiftLM-shaped path is
    /// still rejected. Substring/prefix matches were considered and
    /// rejected — the predicate is byte-for-byte equal so a parallel
    /// install at a slightly different path can't accidentally vouch
    /// for an instance we didn't launch.
    func testPredicateIsByteForByteEqual() {
        // Resolve our own path, then perturb it. The perturbed path
        // points at no real binary, so even if the predicate were
        // accidentally a prefix-check, the comparison should fail.
        guard let me = SwiftLMProcess.executablePath(forPID: getpid()) else {
            XCTFail("Couldn't resolve own path")
            return
        }
        let perturbed = me + "_not_ours"
        XCTAssertFalse(
            SwiftLMProcess.isOurOrphanedSwiftLM(pid: getpid(), ourBinaryPath: perturbed)
        )
    }

    // MARK: - End-to-end: spawn a `sleep`, ensure reclaim refuses to kill it

    /// Spawn an unrelated child (`sleep 30`), pretend it's listening on
    /// our port (we lie about the PID list), and confirm
    /// `reclaimOurOrphans` will not touch it because its binary path
    /// (`/bin/sleep`) doesn't equal `ourBinaryPath`. The child must
    /// survive the call.
    ///
    /// We can't pass a custom PID list into `reclaimOurOrphans` (it
    /// derives them from `lsof`), so this test exercises the predicate
    /// directly — same guarantee, smaller blast radius.
    func testForeignProcessIsNotReclaimed() throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sleep")
        proc.arguments = ["30"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        defer {
            if proc.isRunning {
                proc.terminate()
                proc.waitUntilExit()
            }
        }

        let pid = proc.processIdentifier
        XCTAssertGreaterThan(pid, 0)

        // The actual binary path of `sleep` won't equal our SwiftLM
        // installer path; the predicate must say "not ours".
        let pretendOurs = "/Users/nobody/.slicc/SwiftLM/b602/SwiftLM"
        XCTAssertFalse(
            SwiftLMProcess.isOurOrphanedSwiftLM(pid: pid, ourBinaryPath: pretendOurs),
            "Predicate must reject /bin/sleep — that would be SIGTERMing a stranger"
        )
        XCTAssertTrue(proc.isRunning, "the foreign process must still be alive")
    }
}
