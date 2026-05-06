import Foundation
import AppKit

@Observable
final class AppManagementPermission {
    private(set) var isGranted: Bool = false
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
        isGranted = Self.probeAppManagementAccess()
    }

    /// Re-probe whenever Sliccstart regains focus. The common case for a
    /// state transition is the user toggling the switch in System Settings
    /// → Privacy & Security → App Management and then switching back to
    /// Sliccstart, which fires `didBecomeActive` synchronously on the
    /// return.
    ///
    /// **Why not a timer.** The probe writes a temp file inside a user
    /// app bundle (`/Applications/<App>/Contents/.sliccstart_probe_…`)
    /// because TCC has no read-only API for the App Management
    /// entitlement. On macOS Sonoma+ every denied write into another
    /// app's bundle posts a "Sliccstart was prevented from modifying
    /// apps on your Mac" Notification Center alert, and the previous
    /// 2-second polling timer turned that into a continuous stream of
    /// notifications until the user granted the permission. Focus-driven
    /// re-probing fires at most once per app switch, which matches when
    /// the answer can actually change.
    func startWatchingForGrant() {
        stopWatchingForGrant()
        checkPermission()
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

    /// True between `startWatchingForGrant()` and `stopWatchingForGrant()`.
    /// Exists so tests (and any future debug surface) can confirm the
    /// observer slot lifecycle without reflecting into `@Observable`'s
    /// rewritten storage.
    var isWatching: Bool {
        activationObserver != nil
    }
    
    func openSystemSettings() {
        // Open System Settings > Privacy & Security > App Management
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles") {
            NSWorkspace.shared.open(url)
        }
    }
    
    /// Probe whether we have App Management permission by attempting to create
    /// a temp file inside a user-installed app bundle in /Applications.
    /// System apps (Safari, Terminal, etc.) are protected by SIP, not TCC.
    private static func probeAppManagementAccess() -> Bool {
        let fm = FileManager.default
        
        // Find user-installed apps (not in /System, not SIP-protected)
        // We look for apps that are NOT signed by Apple system certificates
        guard let contents = try? fm.contentsOfDirectory(atPath: "/Applications") else {
            return true
        }
        
        // Known third-party apps that are commonly installed
        let preferredTestApps = [
            "Slack.app", "Discord.app", "Spotify.app", "Visual Studio Code.app",
            "Microsoft Teams.app", "Figma.app", "Notion.app", "1Password.app",
            "Zoom.app", "Google Chrome.app", "Firefox.app", "Brave Browser.app"
        ]
        
        // Try preferred apps first, then any .app
        var testApps: [String] = []
        for preferred in preferredTestApps {
            if contents.contains(preferred) {
                testApps.append("/Applications/\(preferred)")
            }
        }
        // Add any other apps as fallback
        for item in contents where item.hasSuffix(".app") && !preferredTestApps.contains(item) {
            testApps.append("/Applications/\(item)")
        }
        
        for appPath in testApps {
            let contentsPath = "\(appPath)/Contents"
            guard fm.fileExists(atPath: contentsPath) else { continue }
            
            // Skip Apple system apps (SIP-protected)
            if isAppleSystemApp(appPath) {
                continue
            }
            
            // Skip apps owned by root (require admin privileges regardless of TCC)
            if isRootOwned(appPath) {
                continue
            }
            
            let testFile = "\(contentsPath)/.sliccstart_probe_\(UUID().uuidString)"
            
            // Reset errno before the operation
            errno = 0
            
            // Try to create a temp file
            if fm.createFile(atPath: testFile, contents: nil) {
                // Success - we have permission, clean up
                try? fm.removeItem(atPath: testFile)
                return true
            }
            
            // Check the error
            let errorCode = errno
            
            // EPERM from a user-owned app means TCC denial
            // EACCES (13) also means permission denied
            if errorCode == EPERM || errorCode == EACCES {
                return false
            }
        }
        
        // No user-installed apps found, or all failed for non-permission reasons
        return true
    }
    
    /// Check if an app is an Apple system app (SIP-protected)
    private static func isAppleSystemApp(_ appPath: String) -> Bool {
        // System apps that are always SIP-protected
        let sipProtectedApps = [
            "Safari.app", "Mail.app", "Messages.app", "FaceTime.app",
            "Calendar.app", "Contacts.app", "Notes.app", "Reminders.app",
            "Photos.app", "Music.app", "TV.app", "Podcasts.app", "News.app",
            "Stocks.app", "Home.app", "Voice Memos.app", "Books.app",
            "Preview.app", "TextEdit.app", "QuickTime Player.app",
            "App Store.app", "System Preferences.app", "System Settings.app"
        ]
        let appName = (appPath as NSString).lastPathComponent
        return sipProtectedApps.contains(appName)
    }
    
    /// Check if an app is owned by root (requires admin privileges regardless of TCC)
    private static func isRootOwned(_ appPath: String) -> Bool {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: appPath),
              let ownerUID = attrs[.ownerAccountID] as? Int else {
            return false
        }
        return ownerUID == 0  // root UID is 0
    }
}
