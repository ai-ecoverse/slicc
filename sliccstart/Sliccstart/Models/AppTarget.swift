import AppKit

enum AppTargetType: String, Codable {
    case chromiumBrowser
    case electronApp
}

struct AppTarget: Identifiable {
    let id: String              // bundle path
    let name: String            // display name
    let path: String            // /Applications/Foo.app
    let executablePath: String  // /Applications/Foo.app/Contents/MacOS/Foo
    let type: AppTargetType
    let icon: NSImage

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
