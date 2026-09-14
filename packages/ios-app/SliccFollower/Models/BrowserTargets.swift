import Foundation
import SliccTrayKit





enum BrowserTargets {

    
    
    
    static func visible(
        _ targets: [TrayTargetEntry],
        ownRuntimeId: String,
        joinUrl: String
    ) -> [TrayTargetEntry] {
        targets.filter { target in
            target.runtimeId != ownRuntimeId && !isSliccAppPage(target.url, joinUrl: joinUrl)
        }
    }

    
    
    
    
    
    
    
    static func isSliccAppPage(_ url: String, joinUrl: String) -> Bool {
        guard let candidate = appIdentity(of: url) else { return false }
        if let leader = appIdentity(of: joinUrl), candidate == leader { return true }
        
        
        return hostedAppShells.contains(candidate)
    }

    
    
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

    
    private static let hostedAppShells: Set<String> = [
        "https://sliccy.ai",
        "https://www.sliccy.ai",
    ]
}
