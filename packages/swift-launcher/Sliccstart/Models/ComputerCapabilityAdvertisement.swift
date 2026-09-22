import Foundation
import SliccTrayFollower

/// One beat of the grant watch: waits, then says whether to keep watching.
///
/// TCC has no change notification, so looking again is the only way a grant
/// ticked in System Settings mid-session reaches the leader. Injected so tests
/// drive a bounded number of immediate beats instead of sleeping.
typealias ComputerGrantTick = @Sendable () async -> Bool

enum ComputerGrantWatch {
    /// The launcher's existing runtime-refresh cadence. A preflight read is a
    /// cached TCC lookup, not a prompt, so it is cheap to repeat.
    static let intervalSeconds: Double = 2

    static let liveTick: ComputerGrantTick = {
        let ns = UInt64((intervalSeconds * 1_000_000_000).rounded())
        return (try? await Task.sleep(nanoseconds: ns)) != nil
    }
}

/// What this Mac tells the leader it can do, derived from the live TCC grants
/// rather than asserted as a constant (#3387).
///
/// `capabilities.computer` used to be hardcoded `true`. A Mac whose Screen
/// Recording grant was missing or revoked still claimed native capture, so
/// `computer add ssh` picked the native backend, skipped the
/// `screencapture` + `cliclick` tray-exec fallback that would have worked, and
/// the agent got an error where a degraded-but-working capture was reachable.
///
/// The wire carries one boolean, so the Accessibility half — which gates input,
/// not capture — travels in the MOTD. The leader already shows a follower's MOTD
/// beside its roster entry, which makes a missing grant *readable* rather than
/// only discoverable by trying to inject an event and failing.
enum ComputerCapabilityAdvertisement {
    static func capabilities(for grants: ComputerGrants) -> TraySyncCapabilities {
        TraySyncCapabilities(exec: false, computer: grants.canCaptureNatively)
    }

    /// One line naming what works and what the human has to tick. Every denied
    /// variant names System Settings, matching ``ComputerPermissionError``.
    static func motd(host: String, grants: ComputerGrants) -> String {
        switch (grants.screenRecording, grants.accessibility) {
        case (true, true):
            return "Native screen capture on \(host)"
        case (true, false):
            return
                "Native screen capture on \(host) — input needs Accessibility in System Settings → Privacy & Security"
        case (false, true):
            return
                "\(host): no native screen capture — grant Screen Recording in System Settings → Privacy & Security"
        case (false, false):
            return
                "\(host): no native screen capture or input — grant Screen Recording and Accessibility in System Settings → Privacy & Security"
        }
    }
}
