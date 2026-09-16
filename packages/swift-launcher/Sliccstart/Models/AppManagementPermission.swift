import AppKit
import Foundation

@Observable

class AppManagementPermission {
    private(set) var isGranted: Bool = false

    private(set) var probeCount: Int = 0
    private var activationObserver: NSObjectProtocol?

    init() {
        checkPermission()
    }

    deinit {
        if let activationObserver {
            NotificationCenter.default.removeObserver(activationObserver)
        }
    }

    func checkPermission() {
        probeCount += 1
        isGranted = Self.probeAppManagementAccess()
    }

    func startWatchingForGrant() {
        stopWatchingForGrant()
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.checkPermission()
        }
    }

    func stopWatchingForGrant() {
        if let activationObserver {
            NotificationCenter.default.removeObserver(activationObserver)
            self.activationObserver = nil
        }
    }

    var isWatching: Bool {
        activationObserver != nil
    }

    func openSystemSettings() {

        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles") {
            NSWorkspace.shared.open(url)
        }
    }

    private static func probeAppManagementAccess() -> Bool {
        let fm = FileManager.default

        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return true
        }

        let preferredTestApps = [
            "Slack.app", "Discord.app", "Spotify.app", "Visual Studio Code.app",
            "Microsoft Teams.app", "Figma.app", "Notion.app", "1Password.app",
            "Zoom.app", "Google Chrome.app", "Firefox.app", "Brave Browser.app",
        ]

        var testApps: [String] = []
        for preferred in preferredTestApps {
            if contents.contains(preferred) {
                testApps.append("/Applications/\(preferred)")
            }
        }

        for item in contents where item.hasSuffix(".app") && !preferredTestApps.contains(item) {
            testApps.append("/Applications/\(item)")
        }

        for appPath in testApps {
            let contentsPath = "\(appPath)/Contents"
            guard fm.fileExists(atPath: contentsPath) else { continue }

            if isAppleSystemApp(appPath) {
                continue
            }

            if isRootOwned(appPath) {
                continue
            }

            let testFile = "\(contentsPath)/.sliccstart_probe_\(UUID().uuidString)"

            errno = 0

            if fm.createFile(atPath: testFile, contents: nil) {

                try? fm.removeItem(atPath: testFile)
                return true
            }

            let errorCode = errno

            if errorCode == EPERM || errorCode == EACCES {
                return false
            }
        }

        return true
    }

    private static func isAppleSystemApp(_ appPath: String) -> Bool {

        let sipProtectedApps = [
            "Safari.app", "Mail.app", "Messages.app", "FaceTime.app",
            "Calendar.app", "Contacts.app", "Notes.app", "Reminders.app",
            "Photos.app", "Music.app", "TV.app", "Podcasts.app", "News.app",
            "Stocks.app", "Home.app", "Voice Memos.app", "Books.app",
            "Preview.app", "TextEdit.app", "QuickTime Player.app",
            "App Store.app", "System Preferences.app", "System Settings.app",
        ]
        let appName = (appPath as NSString).lastPathComponent
        return sipProtectedApps.contains(appName)
    }

    private static func isRootOwned(_ appPath: String) -> Bool {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: appPath),
            let ownerUID = attrs[.ownerAccountID] as? Int
        else {
            return false
        }
        return ownerUID == 0
    }
}
