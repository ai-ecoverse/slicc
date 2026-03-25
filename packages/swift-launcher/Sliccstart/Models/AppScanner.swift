import AppKit
import Foundation

final class AppScanner {
    /// Directory for debug builds
    static var userApplicationsDir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Applications"
    }

    static func scan(hasAppManagementPermission: Bool = true) -> [AppTarget] {
        var targets: [AppTarget] = []
        var debugBuilds: [String: AppTarget] = [:] // originalPath -> debugTarget

        // First scan ~/Applications for debug builds (user-owned, no TCC prompt)
        let fm = FileManager.default
        if let userApps = try? fm.contentsOfDirectory(atPath: userApplicationsDir) {
            for item in userApps where item.hasSuffix(" Debug.app") {
                let debugPath = "\(userApplicationsDir)/\(item)"
                guard hasCDPFramework(atPath: debugPath) else { continue }
                let baseName = String(item.dropLast(" Debug.app".count))
                let originalPath = "/Applications/\(baseName).app"
                let name = "\(baseName)"
                let icon = NSWorkspace.shared.icon(forFile: debugPath)
                let debugTarget = AppTarget(
                    id: debugPath, name: name, path: debugPath,
                    executablePath: executablePath(forApp: debugPath, name: baseName),
                    type: .electronApp, icon: icon,
                    debugSupport: .supported,
                    isDebugBuild: true,
                    originalAppPath: originalPath
                )
                debugBuilds[originalPath] = debugTarget
            }
        }

        // Known Chromium browsers by bundle ID
        for (bundleId, displayName) in AppTarget.knownChromiumBrowsers {
            guard let url = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: bundleId
            ) else { continue }
            let path = url.path
            let name = appName(fromPath: path)
            let icon = NSWorkspace.shared.icon(forFile: path)
            targets.append(AppTarget(
                id: path, name: displayName, path: path,
                executablePath: executablePath(forApp: path, name: name),
                type: .chromiumBrowser, icon: icon,
                debugSupport: .supported,
                isDebugBuild: false,
                originalAppPath: nil
            ))
        }

        // Without App Management permission we can't peek inside app bundles
        // (each fileExists on Contents/Frameworks/ triggers a TCC prompt).
        // Instead, discover known Electron apps by bundle ID — no TCC needed.
        guard hasAppManagementPermission else {
            for (bundleId, displayName) in AppTarget.knownElectronApps {
                guard let url = NSWorkspace.shared.urlForApplication(
                    withBundleIdentifier: bundleId
                ) else { continue }
                let appPath = url.path
                // Skip if a debug build already covers this app
                if debugBuilds[appPath] != nil { continue }
                let name = appName(fromPath: appPath)
                let icon = NSWorkspace.shared.icon(forFile: appPath)
                targets.append(AppTarget(
                    id: appPath, name: displayName, path: appPath,
                    executablePath: executablePath(forApp: appPath, name: name),
                    type: .electronApp, icon: icon,
                    debugSupport: .unknown,
                    isDebugBuild: false,
                    originalAppPath: nil
                ))
            }
            targets.append(contentsOf: debugBuilds.values)
            return targets.sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        }

        // Scan /Applications for CDP-compatible desktop apps (Electron, WebView2)
        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return targets
        }
        for item in contents where item.hasSuffix(".app") {
            let appPath = "/Applications/\(item)"
            if targets.contains(where: { $0.path == appPath }) { continue }
            guard hasCDPFramework(atPath: appPath) else { continue }

            // If there's a debug build for this app, use that instead
            if let debugTarget = debugBuilds[appPath] {
                targets.append(debugTarget)
                continue
            }

            let name = appName(fromPath: appPath)
            let icon = NSWorkspace.shared.icon(forFile: appPath)
            let debugSupport = checkDebugSupport(atPath: appPath)
            targets.append(AppTarget(
                id: appPath, name: name, path: appPath,
                executablePath: executablePath(forApp: appPath, name: name),
                type: .electronApp, icon: icon,
                debugSupport: debugSupport,
                isDebugBuild: false,
                originalAppPath: nil
            ))
        }

        return targets.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    static func isChromiumBrowser(bundleId: String) -> Bool {
        AppTarget.knownChromiumBrowsers.contains { $0.bundleId == bundleId }
    }

    /// Checks whether the app embeds a CDP-compatible browser engine
    /// (Electron Framework or Microsoft Edge WebView2).
    static func hasCDPFramework(atPath appPath: String) -> Bool {
        let fm = FileManager.default
        // Electron apps
        if fm.fileExists(atPath: "\(appPath)/Contents/Frameworks/Electron Framework.framework") {
            return true
        }
        // Microsoft Edge WebView2 apps (e.g. Teams)
        if fm.fileExists(atPath: "\(appPath)/Contents/Frameworks/MSWebView2.framework") {
            return true
        }
        return false
    }

    /// Check if an Electron app has remote debugging enabled
    /// This checks for known apps that block remote debugging at the application level
    /// (beyond just the Electron fuse). Fuse checking alone is unreliable across Electron versions.
    static func checkDebugSupport(atPath appPath: String) -> ElectronDebugSupport {
        let fm = FileManager.default
        let electronFramework = "\(appPath)/Contents/Frameworks/Electron Framework.framework"
        guard fm.fileExists(atPath: electronFramework) else {
            return .supported // Not Electron - assume it works
        }

        // Known apps that block remote debugging at the application level
        // These apps have explicit checks in their JavaScript code that exit
        // when --remote-debugging-port is detected, even if the Electron fuse allows it.
        let knownBlockedApps = [
            "Claude",       // Checks CLAUDE_CDP_AUTH JWT, exits without it
            "1Password",    // Security-focused, blocks remote debugging
        ]

        let appName = self.appName(fromPath: appPath)
        if knownBlockedApps.contains(appName) {
            return .disabled
        }

        // For all other Electron apps, assume remote debugging works.
        // The Electron fuse system is inconsistent across versions and
        // many apps work fine even when the fuse appears disabled.
        return .supported
    }

    static func appName(fromPath path: String) -> String {
        let filename = (path as NSString).lastPathComponent
        return filename.hasSuffix(".app") ? String(filename.dropLast(4)) : filename
    }

    static func executablePath(forApp appPath: String, name: String) -> String {
        "\(appPath)/Contents/MacOS/\(name)"
    }
}
