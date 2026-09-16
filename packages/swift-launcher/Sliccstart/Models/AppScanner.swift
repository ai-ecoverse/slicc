import AppKit
import Foundation

final class AppScanner {

    static var userApplicationsDir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Applications"
    }

    static func scan(hasAppManagementPermission: Bool = true) -> [AppTarget] {
        var targets: [AppTarget] = []
        var debugBuilds: [String: AppTarget] = [:]

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

        for (bundleId, displayName) in AppTarget.knownChromiumBrowsers {
            guard
                let url = NSWorkspace.shared.urlForApplication(
                    withBundleIdentifier: bundleId
                )
            else { continue }
            let path = url.path
            let name = appName(fromPath: path)
            let icon = NSWorkspace.shared.icon(forFile: path)
            targets.append(
                AppTarget(
                    id: path, name: displayName, path: path,
                    executablePath: executablePath(forApp: path, name: name),
                    type: .chromiumBrowser, icon: icon,
                    debugSupport: .supported,
                    isDebugBuild: false,
                    originalAppPath: nil,
                    bundleId: bundleId
                ))
        }

        for (bundleId, displayName) in AppTarget.knownTerminals {
            guard
                let url = NSWorkspace.shared.urlForApplication(
                    withBundleIdentifier: bundleId
                )
            else { continue }
            let path = url.path
            let name = appName(fromPath: path)
            let icon = NSWorkspace.shared.icon(forFile: path)
            let executable =
                Bundle(url: url)?.executableURL?.path
                ?? executablePath(forApp: path, name: name)
            targets.append(
                AppTarget(
                    id: path, name: displayName, path: path,
                    executablePath: executable,
                    type: .terminal, icon: icon,
                    debugSupport: .unknown,
                    isDebugBuild: false,
                    originalAppPath: nil,
                    bundleId: bundleId
                ))
        }

        guard hasAppManagementPermission else {
            for (bundleId, displayName) in AppTarget.knownElectronApps {
                guard
                    let url = NSWorkspace.shared.urlForApplication(
                        withBundleIdentifier: bundleId
                    )
                else { continue }
                let appPath = url.path

                if debugBuilds[appPath] != nil { continue }
                let name = appName(fromPath: appPath)
                let icon = NSWorkspace.shared.icon(forFile: appPath)
                targets.append(
                    AppTarget(
                        id: appPath, name: displayName, path: appPath,
                        executablePath: executablePath(forApp: appPath, name: name),
                        type: .electronApp, icon: icon,
                        debugSupport: .unknown,
                        isDebugBuild: false,
                        originalAppPath: nil,
                        bundleId: bundleId
                    ))
            }
            targets.append(contentsOf: debugBuilds.values)
            return targets.sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        }

        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return targets
        }
        for item in contents where item.hasSuffix(".app") {
            let appPath = "/Applications/\(item)"
            if targets.contains(where: { $0.path == appPath }) { continue }
            guard hasCDPFramework(atPath: appPath) else { continue }

            if let debugTarget = debugBuilds[appPath] {
                targets.append(debugTarget)
                continue
            }

            let name = appName(fromPath: appPath)
            let icon = NSWorkspace.shared.icon(forFile: appPath)
            let debugSupport = checkDebugSupport(atPath: appPath)
            targets.append(
                AppTarget(
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

    static func hasCDPFramework(atPath appPath: String) -> Bool {
        let fm = FileManager.default

        if fm.fileExists(atPath: "\(appPath)/Contents/Frameworks/Electron Framework.framework") {
            return true
        }

        if fm.fileExists(atPath: "\(appPath)/Contents/Frameworks/MSWebView2.framework") {
            return true
        }
        return false
    }

    static func checkDebugSupport(atPath appPath: String) -> ElectronDebugSupport {
        let fm = FileManager.default
        let electronFramework = "\(appPath)/Contents/Frameworks/Electron Framework.framework"
        guard fm.fileExists(atPath: electronFramework) else {
            return .supported
        }

        let knownBlockedApps = [
            "Claude",
            "1Password",
        ]

        let appName = self.appName(fromPath: appPath)
        if knownBlockedApps.contains(appName) {
            return .disabled
        }

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
