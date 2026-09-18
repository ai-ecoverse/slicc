import AppKit

enum AppTargetType: String, Codable {
    case chromiumBrowser
    case electronApp
    case terminal
}


enum ElectronDebugSupport {
    case supported  
    case disabled  
    case unknown  
}

struct AppTarget: Identifiable {
    let id: String  
    let name: String  
    let path: String  
    let executablePath: String  
    let type: AppTargetType
    let icon: NSImage
    let debugSupport: ElectronDebugSupport
    let isDebugBuild: Bool  
    let originalAppPath: String?  
    
    
    
    
    // swiftlint:disable:next redundant_optional_initialization
    var bundleId: String? = nil  

    static let knownChromiumBrowsers: [(bundleId: String, name: String)] = [
        ("com.google.Chrome", "Google Chrome"),
        ("com.google.Chrome.beta", "Google Chrome Beta"),
        ("com.google.Chrome.dev", "Google Chrome Dev"),
        ("com.google.Chrome.canary", "Chrome Canary"),
        ("com.google.chrome.for.testing", "Chrome for Testing"),
        ("com.brave.Browser", "Brave Browser"),
        ("com.brave.Browser.beta", "Brave Beta"),
        ("com.brave.Browser.nightly", "Brave Nightly"),
        ("com.microsoft.edgemac", "Microsoft Edge"),
        ("com.microsoft.edgemac.Beta", "Microsoft Edge Beta"),
        ("com.microsoft.edgemac.Dev", "Microsoft Edge Dev"),
        ("com.microsoft.edgemac.Canary", "Microsoft Edge Canary"),
        ("com.vivaldi.Vivaldi", "Vivaldi"),
        ("com.vivaldi.Vivaldi.snapshot", "Vivaldi Snapshot"),
        ("com.operasoftware.Opera", "Opera"),
        ("company.thebrowser.Browser", "Arc"),
        ("company.thebrowser.dia", "Dia"),
        ("com.openai.atlas", "ChatGPT Atlas"),
        ("org.chromium.Chromium", "Chromium"),
    ]

    static let knownTerminals: [(bundleId: String, name: String)] = [
        ("com.apple.Terminal", "Terminal"),
        ("com.googlecode.iterm2", "iTerm2"),
        ("com.mitchellh.ghostty", "Ghostty"),
        ("com.github.wez.wezterm", "WezTerm"),
        ("net.kovidgoyal.kitty", "kitty"),
        ("org.alacritty", "Alacritty"),
    ]

    
    
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
        ("org.whispersystems.signal-desktop", "Signal"),
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
