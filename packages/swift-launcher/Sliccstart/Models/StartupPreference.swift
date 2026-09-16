import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "Startup")

enum StartupPreference {
    static let enabledKey = "launchBrowserAtStartup"

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

    static func isInstalledLocation(bundlePath: String = Bundle.main.bundlePath) -> Bool {
        let standardized = (bundlePath as NSString).standardizingPath
        let userApplications = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Applications")
        for root in ["/Applications", userApplications] {

            if standardized == root || standardized.hasPrefix(root + "/") { return true }
        }
        return false
    }

    static func shouldAutoLaunch(
        defaults: UserDefaults,
        bundlePath: String = Bundle.main.bundlePath
    ) -> Bool {

        let enabled = resolveEnabled(defaults: defaults)
        guard enabled else { return false }
        guard isInstalledLocation(bundlePath: bundlePath) else {

            log.info(
                "autoLaunch: skipped — running from \(bundlePath, privacy: .public), not an Applications folder"
            )
            return false
        }
        return true
    }
}
