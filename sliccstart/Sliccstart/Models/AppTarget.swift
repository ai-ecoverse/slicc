import AppKit

enum AppTargetType: String, Codable {
    case chromiumBrowser
    case electronApp
}

/// Indicates whether an Electron app supports remote debugging
enum ElectronDebugSupport {
    case supported          // Fuse enabled or patched debug build
    case disabled           // Fuse disabled, needs patching
    case unknown            // Couldn't determine (not Electron or check failed)
}

struct AppTarget: Identifiable {
    let id: String              // bundle path
    let name: String            // display name
    let path: String            // /Applications/Foo.app
    let executablePath: String  // /Applications/Foo.app/Contents/MacOS/Foo
    let type: AppTargetType
    let icon: NSImage
    let debugSupport: ElectronDebugSupport
    let isDebugBuild: Bool      // True if this is a patched debug build
    let originalAppPath: String? // For debug builds, path to original app

    static let knownChromiumBrowsers: [(bundleId: String, name: String)] = [
        ("com.google.Chrome", "Google Chrome"),
        ("com.google.Chrome.canary", "Chrome Canary"),
        ("com.brave.Browser", "Brave Browser"),
        ("com.microsoft.edgemac", "Microsoft Edge"),
        ("com.vivaldi.Vivaldi", "Vivaldi"),
        ("com.operasoftware.Opera", "Opera"),
        ("org.chromium.Chromium", "Chromium"),
    ]
}
