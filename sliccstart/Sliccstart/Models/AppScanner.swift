import AppKit

final class AppScanner {
    static func scan() -> [AppTarget] {
        var targets: [AppTarget] = []

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
                type: .chromiumBrowser, icon: icon
            ))
        }

        // Scan /Applications for CDP-compatible desktop apps (Electron, WebView2)
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return targets
        }
        for item in contents where item.hasSuffix(".app") {
            let appPath = "/Applications/\(item)"
            if targets.contains(where: { $0.path == appPath }) { continue }
            guard hasCDPFramework(atPath: appPath) else { continue }
            let name = appName(fromPath: appPath)
            let icon = NSWorkspace.shared.icon(forFile: appPath)
            targets.append(AppTarget(
                id: appPath, name: name, path: appPath,
                executablePath: executablePath(forApp: appPath, name: name),
                type: .electronApp, icon: icon
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

    static func appName(fromPath path: String) -> String {
        let filename = (path as NSString).lastPathComponent
        return filename.hasSuffix(".app") ? String(filename.dropLast(4)) : filename
    }

    static func executablePath(forApp appPath: String, name: String) -> String {
        "\(appPath)/Contents/MacOS/\(name)"
    }
}
