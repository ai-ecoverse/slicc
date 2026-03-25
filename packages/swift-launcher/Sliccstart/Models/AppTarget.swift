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

    /// Known Electron apps by bundle ID. Used to discover apps without
    /// reading inside their bundles (which requires App Management permission).
    static let knownElectronApps: [(bundleId: String, name: String)] = [
        ("com.microsoft.teams2", "Microsoft Teams"),
        ("com.microsoft.VSCode", "Visual Studio Code"),
        ("com.microsoft.VSCodeInsiders", "VS Code Insiders"),
        ("com.spotify.client", "Spotify"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("com.hnc.Discord", "Discord"),
        ("com.todesktop.230313mzl4w4u92", "Cursor"),
        ("com.figma.Desktop", "Figma"),
        ("notion.id", "Notion"),
        ("com.obsproject.obs-studio", "OBS Studio"),
        ("com.1password.1password", "1Password"),
        ("us.zoom.xos", "Zoom"),
        ("com.linear", "Linear"),
        ("com.loom.desktop", "Loom"),
        ("md.obsidian", "Obsidian"),
        ("com.bitwarden.desktop", "Bitwarden"),
        ("com.todoist.mac.Todoist", "Todoist"),
        ("com.github.GitHubClient", "GitHub Desktop"),
        ("com.postmanlabs.mac", "Postman"),
        ("org.signal.Signal", "Signal"),
        ("com.tdesktop.Telegram", "Telegram Desktop"),
        ("com.logseq.logseq", "Logseq"),
        ("com.whatsonchain.WhatsOnChain", "WhatsOnChain"),
        ("io.trystorybook.app", "Storybook"),
        ("com.mongodb.compass", "MongoDB Compass"),
        ("com.insomnia.app", "Insomnia"),
        ("com.jetbrains.toolbox", "JetBrains Toolbox"),
        ("com.electron.replit", "Replit"),
        ("com.twitch.studio", "Twitch Studio"),
    ]
}
