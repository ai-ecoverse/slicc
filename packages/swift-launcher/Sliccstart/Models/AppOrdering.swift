import Foundation

/// Default ordering for the Browsers and Terminals lists, plus a persisted
/// user-defined override (drag-to-reorder). Pure logic so it is unit-testable
/// without UserDefaults or SwiftUI.
enum AppOrdering {
    /// Browsers, most common first (market share). The top entry is the
    /// default leader and the browser attached to a session by the
    /// session-row shortcut.
    static let browserBundlePriority: [String] = [
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.operasoftware.Opera",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",  // Arc
        "com.openai.atlas",  // ChatGPT Atlas
        "company.thebrowser.dia",  // Dia
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

    /// Terminals, least common first: a deliberately installed power-user
    /// terminal (Alacritty, kitty, …) outranks the ubiquitous Terminal.app,
    /// so the default top pick is the one the user most likely prefers.
    static let terminalBundlePriority: [String] = [
        "org.alacritty",
        "net.kovidgoyal.kitty",
        "com.github.wez.wezterm",
        "com.mitchellh.ghostty",
        "com.googlecode.iterm2",
        "com.apple.Terminal",
    ]

    /// Order `targets` by: the user's saved order first (in that order),
    /// then any remaining known apps by `defaultPriority`, then unknown apps
    /// alphabetically. Stable for equal ranks.
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

    /// The Browsers list in display order. The link handler walks it to find a
    /// browser that can still become the leader.
    static func orderedBrowsers(in targets: [AppTarget], savedOrder: [String]) -> [AppTarget] {
        ordered(
            targets.filter { $0.type == .chromiumBrowser },
            savedOrder: savedOrder,
            defaultPriority: browserBundlePriority
        )
    }

    /// The browser Sliccstart starts by itself — startup auto-launch and the
    /// default-browser link handler both use this pick, so they can never
    /// disagree about which browser is "the" leader.
    static func topBrowser(in targets: [AppTarget], savedOrder: [String]) -> AppTarget? {
        orderedBrowsers(in: targets, savedOrder: savedOrder).first
    }

    /// The bundle-id order to persist after a drag reorder produced
    /// `reordered`. Targets without a bundle id are skipped (they can't be
    /// keyed), so their relative position is governed by default priority.
    static func persistableOrder(from reordered: [AppTarget]) -> [String] {
        reordered.compactMap { $0.bundleId }
    }

    /// Move `moving` to the current position of `over` within `ids`. Returns
    /// `ids` unchanged when the two match or either id is absent — the pure
    /// core of the drag-reorder drop delegate, so it is unit-testable without
    /// SwiftUI drag events.
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

/// Whether clicking a browser row should launch it standalone or offer the
/// lead-vs-attach dialog. Split out so the choice is unit-testable without the
/// view. A running browser (re-focus/restart) or the absence of any remote
/// iCloud session both go straight to standalone — the dialog only helps when
/// there is a remote tray to attach to.
enum BrowserLaunchAction: Equatable {
    case standalone
    case chooseLeadOrAttach

    static func resolve(isRunning: Bool, hasAttachableSessions: Bool) -> BrowserLaunchAction {
        (isRunning || !hasAttachableSessions) ? .standalone : .chooseLeadOrAttach
    }
}

/// UserDefaults-backed persistence for custom Browsers/Terminals ordering.
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
