import Foundation

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
}
