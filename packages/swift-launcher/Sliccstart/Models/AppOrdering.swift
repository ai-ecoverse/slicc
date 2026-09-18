import Foundation




enum AppOrdering {
    
    
    
    static let browserBundlePriority: [String] = [
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.operasoftware.Opera",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",  
        "com.openai.atlas",  
        "company.thebrowser.dia",  
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.google.Chrome.canary",
        "com.brave.Browser.beta",
        "com.brave.Browser.nightly",
        "com.microsoft.edgemac.Beta",
        "com.microsoft.edgemac.Dev",
        "com.microsoft.edgemac.Canary",
        "com.vivaldi.Vivaldi.snapshot",
        "com.google.chrome.for.testing",
        "org.chromium.Chromium",
    ]

    
    
    
    static let terminalBundlePriority: [String] = [
        "org.alacritty",
        "net.kovidgoyal.kitty",
        "com.github.wez.wezterm",
        "com.mitchellh.ghostty",
        "com.googlecode.iterm2",
        "com.apple.Terminal",
    ]

    
    
    
    static func ordered(
        _ targets: [AppTarget],
        savedOrder: [String],
        defaultPriority: [String]
    ) -> [AppTarget] {
        func rank(_ target: AppTarget) -> Int {
            guard let bundleId = target.bundleId else {
                return savedOrder.count + defaultPriority.count
            }
            if let saved = savedOrder.firstIndex(of: bundleId) {
                return saved
            }
            if let def = defaultPriority.firstIndex(of: bundleId) {
                return savedOrder.count + def
            }
            return savedOrder.count + defaultPriority.count
        }
        return
            targets
            .enumerated()
            .sorted { lhs, rhs in
                let a = rank(lhs.element)
                let b = rank(rhs.element)
                if a != b { return a < b }
                let byName = lhs.element.name.localizedCaseInsensitiveCompare(rhs.element.name)
                if byName != .orderedSame { return byName == .orderedAscending }
                return lhs.offset < rhs.offset
            }
            .map { $0.element }
    }

    
    
    static func orderedBrowsers(in targets: [AppTarget], savedOrder: [String]) -> [AppTarget] {
        ordered(
            targets.filter { $0.type == .chromiumBrowser },
            savedOrder: savedOrder,
            defaultPriority: browserBundlePriority
        )
    }

    
    
    
    static func topBrowser(in targets: [AppTarget], savedOrder: [String]) -> AppTarget? {
        orderedBrowsers(in: targets, savedOrder: savedOrder).first
    }

    
    
    
    static func persistableOrder(from reordered: [AppTarget]) -> [String] {
        reordered.compactMap { $0.bundleId }
    }

    
    
    
    
    static func reorder(_ ids: [String], moving: String, over: String) -> [String] {
        guard moving != over,
            let from = ids.firstIndex(of: moving),
            let to = ids.firstIndex(of: over)
        else { return ids }
        var next = ids
        next.insert(next.remove(at: from), at: to)
        return next
    }
}






enum BrowserLaunchAction: Equatable {
    case standalone
    case chooseLeadOrAttach

    static func resolve(isRunning: Bool, hasAttachableSessions: Bool) -> BrowserLaunchAction {
        (isRunning || !hasAttachableSessions) ? .standalone : .chooseLeadOrAttach
    }
}


struct AppOrderStore {
    static let browserKey = "browserOrder"
    static let terminalKey = "terminalOrder"

    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load(_ key: String) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    func save(_ bundleIds: [String], forKey key: String) {
        defaults.set(bundleIds, forKey: key)
    }
}
