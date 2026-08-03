import Foundation

/// Which federated tabs the browser surface should list.
///
/// Pure so the rules are unit-testable without a leader (same reason
/// `DockModel` is a pure builder).
enum BrowserTargets {

    /// Tabs worth showing as preview cards: everything the tray federates,
    /// minus our own advertised targets (those are the live local carousel)
    /// and minus the leader's own SLICC page.
    static func visible(
        _ targets: [TrayTargetEntry],
        ownRuntimeId: String,
        joinUrl: String
    ) -> [TrayTargetEntry] {
        targets.filter { target in
            target.runtimeId != ownRuntimeId && !isSliccAppPage(target.url, joinUrl: joinUrl)
        }
    }

    /// True for the page the leader itself runs in.
    ///
    /// It is federated like any other tab — the leader enumerates its whole
    /// browser — but it is the app this follower is already attached to, not
    /// something to browse. Matching is on scheme + host + path so the
    /// per-session `?ws=…#tray=…` on the join URL never defeats it, and so a
    /// genuine `sliccy.ai/docs/...` tab still lists.
    static func isSliccAppPage(_ url: String, joinUrl: String) -> Bool {
        guard let candidate = appIdentity(of: url) else { return false }
        if let leader = appIdentity(of: joinUrl), candidate == leader { return true }
        // A follower can dial in from a saved session whose join URL has since
        // been cleared, so fall back to the hosted origin's app shell.
        return hostedAppShells.contains(candidate)
    }

    /// `scheme://host[:port]/path` with the query, fragment, trailing slash
    /// and an explicit `index.html` removed.
    private static func appIdentity(of raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let components = URLComponents(string: trimmed),
            let host = components.host?.lowercased(), !host.isEmpty
        else { return nil }
        let scheme = (components.scheme ?? "https").lowercased()
        var authority = host
        if let port = components.port { authority += ":\(port)" }
        var path = components.path.lowercased()
        if path.hasSuffix("/index.html") { path.removeLast("index.html".count) }
        while path.hasSuffix("/") { path.removeLast() }
        return "\(scheme)://\(authority)\(path)"
    }

    /// The hosted leader's app shell, in the forms the origin serves it.
    private static let hostedAppShells: Set<String> = [
        "https://sliccy.ai",
        "https://www.sliccy.ai",
    ]
}
