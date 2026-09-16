import Foundation
import WebKit

enum CDPNetworkDomain {

    static func isSupported(_ method: String) -> Bool {
        switch method {
        case "Network.enable", "Network.disable", "Network.getCookies",
            "Network.getAllCookies", "Network.setCookie", "Network.setCookies",
            "Network.deleteCookies", "Network.clearBrowserCookies":
            return true
        default:
            return false
        }
    }

    static func encode(_ cookie: HTTPCookie) -> [String: Any] {
        var out: [String: Any] = [
            "name": cookie.name,
            "value": cookie.value,
            "domain": cookie.domain,
            "path": cookie.path,
            "secure": cookie.isSecure,
            "httpOnly": cookie.isHTTPOnly,
            "session": cookie.expiresDate == nil,
        ]

        let expires: Double = cookie.expiresDate.map { $0.timeIntervalSince1970 } ?? -1
        out["expires"] = expires
        switch cookie.sameSitePolicy {
        case .some(.sameSiteStrict): out["sameSite"] = "Strict"
        case .some(.sameSiteLax): out["sameSite"] = "Lax"
        default: break
        }
        return out
    }

    static func decode(_ raw: [String: Any]) -> HTTPCookie? {
        guard let name = raw["name"] as? String,
            let value = raw["value"] as? String
        else { return nil }
        let domain = (raw["domain"] as? String) ?? ""
        guard !domain.isEmpty else { return nil }

        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: (raw["path"] as? String) ?? "/",
        ]
        if (raw["secure"] as? Bool) == true { props[.secure] = "TRUE" }
        if let expires = raw["expires"] as? Double, expires > 0 {
            props[.expires] = Date(timeIntervalSince1970: expires)
        }
        if let sameSite = raw["sameSite"] as? String {
            switch sameSite.lowercased() {
            case "strict": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
            case "lax": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
            default: break
            }
        }
        return HTTPCookie(properties: props)
    }

    static func filter(_ cookies: [HTTPCookie], urls: [String]) -> [HTTPCookie] {
        let hosts = urls.compactMap { URL(string: $0)?.host?.lowercased() }
        guard !hosts.isEmpty else { return [] }
        return cookies.filter { cookie in
            hosts.contains { domainMatches(cookieDomain: cookie.domain, host: $0) }
        }
    }

    private static func domainMatches(cookieDomain: String, host: String) -> Bool {
        let domain = cookieDomain.lowercased()
        let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
        return host == bare || host.hasSuffix(".\(bare)")
    }

    static func matchesDeletion(
        _ cookie: HTTPCookie,
        name: String,
        domain: String?,
        path: String?,
        pathIsExact: Bool
    ) -> Bool {
        guard cookie.name == name else { return false }
        if let domain, !domain.isEmpty {
            let want = domain.lowercased()
            let wantBare = want.hasPrefix(".") ? String(want.dropFirst()) : want
            guard domainMatches(cookieDomain: cookie.domain, host: wantBare) else { return false }
        }
        guard let path, !path.isEmpty else { return true }
        if pathIsExact { return cookie.path == path }
        return path == cookie.path || path.hasPrefix(cookie.path.hasSuffix("/") ? cookie.path : "\(cookie.path)/")
    }
}
