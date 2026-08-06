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
    static func filter(_ cookies: [HTTPCookie], urls: [String]) -> [HTTPCookie] {
        guard !urls.isEmpty else { return cookies }
        let hosts = urls.compactMap { URL(string: $0)?.host?.lowercased() }
        guard !hosts.isEmpty else { return cookies }
        return cookies.filter { cookie in
            let domain = cookie.domain.lowercased()
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            return hosts.contains { host in host == bare || host.hasSuffix(".\(bare)") }
        }
    }
}
