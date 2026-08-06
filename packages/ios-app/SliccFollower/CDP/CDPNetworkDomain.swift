import Foundation
import WebKit

/// CDP `Network` domain backed by `WKHTTPCookieStore`.
///
/// Only the cookie surface is real. WKWebView exposes no request/response
/// stream, so the traffic-inspection methods (`Network.enable` aside) return a
/// proper not-implemented error rather than an empty success — a silent `{}`
/// is what previously let a cookie teleport "succeed" while delivering
/// nothing (the leader read `result.cookies ?? []` as zero cookies).
///
/// Every target shares `WKWebsiteDataStore.default()`, so cookies written here
/// are visible to every tab in the app and survive relaunch — the same
/// persistence a desktop browser profile gives the leader.
enum CDPNetworkDomain {
    /// Methods this bridge genuinely implements.
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

    /// Serialize an `HTTPCookie` into the CDP `Network.Cookie` shape the
    /// leader's teleport code round-trips (`CookieTeleportCookie`).
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
        // CDP expresses expiry as seconds since epoch; -1 marks a session
        // cookie. Annotated: with a bare `?? -1` in an `Any` context Swift
        // boxes the fallback as `Int`, so session and expiring cookies would
        // serialize with different numeric types.
        let expires: Double = cookie.expiresDate.map { $0.timeIntervalSince1970 } ?? -1
        out["expires"] = expires
        switch cookie.sameSitePolicy {
        case .some(.sameSiteStrict): out["sameSite"] = "Strict"
        case .some(.sameSiteLax): out["sameSite"] = "Lax"
        default: break
        }
        return out
    }

    /// Rebuild an `HTTPCookie` from the CDP shape. Returns nil when the payload
    /// lacks the properties `HTTPCookie` requires (name/value/domain/path).
    ///
    /// Known degradation: `httpOnly` cannot be set through the public
    /// `HTTPCookiePropertyKey` API, so an HttpOnly cookie is recreated without
    /// that flag. It still authenticates; it is merely readable by JS in this
    /// WebView.
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

    /// Keep only cookies whose domain matches one of `urls`, mirroring the
    /// filtering CDP applies to `Network.getCookies { urls }`.
    ///
    /// Empty `urls` yields NOTHING, not everything. CDP scopes an omitted
    /// `urls` to the attached page and its subframes; every target here shares
    /// one app-wide `WKWebsiteDataStore`, so returning the unfiltered store
    /// would hand the caller every cookie on the device. `Network.getAllCookies`
    /// is the method that means "all of them" — the caller resolves the page
    /// URL and passes it, and a target with no resolvable URL gets no cookies
    /// rather than all of them.
    static func filter(_ cookies: [HTTPCookie], urls: [String]) -> [HTTPCookie] {
        let hosts = urls.compactMap { URL(string: $0)?.host?.lowercased() }
        guard !hosts.isEmpty else { return [] }
        return cookies.filter { cookie in
            hosts.contains { domainMatches(cookieDomain: cookie.domain, host: $0) }
        }
    }

    /// Host-vs-cookie-domain match: exact, or a subdomain of a `.example.com`
    /// style domain cookie.
    private static func domainMatches(cookieDomain: String, host: String) -> Bool {
        let domain = cookieDomain.lowercased()
        let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
        return host == bare || host.hasSuffix(".\(bare)")
    }

    /// Should `Network.deleteCookies { name, url, domain, path }` remove this
    /// cookie?
    ///
    /// Name alone is not enough: the store is app-wide, so deleting every
    /// `session` cookie would sign the user out of unrelated sites. `domain`
    /// (explicit, or the host of `url`) and `path` narrow it the way CDP does.
    /// An explicit `path` must match exactly; a path derived from `url` uses
    /// the standard cookie path-match (the cookie's path is a prefix of it),
    /// because that is the set the URL would actually send.
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
