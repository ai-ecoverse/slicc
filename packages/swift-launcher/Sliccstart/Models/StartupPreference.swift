import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "Startup")

/// Whether Sliccstart auto-launches a browser leader at startup. Replaces the
/// legacy per-browser `autoLaunchAppId` picker: the browser to launch is now
/// the top of the (reorderable) Browsers list, so this is a single boolean.
enum StartupPreference {
    static let enabledKey = "launchBrowserAtStartup"

    /// Resolve the boolean, migrating the legacy `autoLaunchAppId` (a
    /// non-empty bundle path meant "auto-launch this browser") into the new
    /// key the first time, then persisting so the Settings checkbox reflects
    /// it. Idempotent: once the boolean exists it wins.
    @discardableResult
    static func resolveEnabled(defaults: UserDefaults) -> Bool {
        if defaults.object(forKey: enabledKey) != nil {
            return defaults.bool(forKey: enabledKey)
        }
        let legacy = defaults.string(forKey: autoLaunchAppIdKey) ?? ""
        let enabled = !legacy.isEmpty
        defaults.set(enabled, forKey: enabledKey)
        return enabled
    }

    /// Whether this copy of Sliccstart is one the user installed, i.e. it
    /// lives in `/Applications` or `~/Applications`.
    ///
    /// Auto-launch is a *startup* behavior — it belongs to the app the user
    /// chose to keep, not to every copy of it that happens to run. Without
    /// this check, opening a build straight out of `packages/swift-launcher/
    /// build/`, a `.zip` still sitting in `~/Downloads`, or the randomized
    /// read-only copy Gatekeeper makes when a quarantined app is launched in
    /// place (App Translocation) all start a browser session and take over the
    /// user's screen — from a copy they may only have meant to look at.
    /// A CI or developer build has the same problem, which is how this was
    /// found: a test run of the launcher would have opened a real browser.
    ///
    /// The preference itself is untouched, so the Settings toggle keeps its
    /// value and takes effect again the moment the app is in Applications.
    static func isInstalledLocation(bundlePath: String = Bundle.main.bundlePath) -> Bool {
        let standardized = (bundlePath as NSString).standardizingPath
        let userApplications = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Applications")
        for root in ["/Applications", userApplications] {
            // Prefix match on a path *component* boundary: `/Applications` and
            // `/Applications/Utilities/x.app` count, `/ApplicationsOld/x.app`
            // does not.
            if standardized == root || standardized.hasPrefix(root + "/") { return true }
        }
        return false
    }

    /// The gate `LauncherModel` actually asks: the user turned auto-launch on
    /// **and** this is the installed app. See {@link isInstalledLocation}.
    static func shouldAutoLaunch(
        defaults: UserDefaults,
        bundlePath: String = Bundle.main.bundlePath
    ) -> Bool {
        // Resolve first, always: it also migrates the legacy preference, and
        // short-circuiting on location would leave that undone.
        let enabled = resolveEnabled(defaults: defaults)
        guard enabled else { return false }
        guard isInstalledLocation(bundlePath: bundlePath) else {
            // Say so: a checkbox that is on and does nothing is otherwise an
            // unexplainable bug report.
            log.info(
                "autoLaunch: skipped — running from \(bundlePath, privacy: .public), not an Applications folder"
            )
            return false
        }
        return true
    }
}
