import Foundation

/// Builds the helix-rum-js `referer` string from a configured app id and the
/// current view path.
///
/// In `helix-rum-js`, `referer = window.location.origin + window.location.pathname`.
/// Native apps have no URL, so we substitute the app id (typically a bundle
/// identifier such as `com.example.app`) as the hostname:
///
/// ```
/// https://{appID}{viewPath}
/// ```
///
/// `viewPath` is normalized to always begin with `/` so the result mirrors a
/// browser `origin + pathname` value even when callers pass an empty or
/// relative path.
public enum RUMReferer {
    /// Default collector base URL, matching `helix-rum-js` (`https://rum.hlx.page/`).
    public static let defaultCollectBaseURL = URL(string: "https://rum.hlx.page/")!

    /// Construct a `referer` string from an app id and view path.
    ///
    /// - Parameters:
    ///   - appID: Application identifier used as the URL hostname.
    ///   - viewPath: Path component for the current view. May be empty,
    ///     leading-slash-prefixed, or relative; the result always has a
    ///     leading slash after the host.
    public static func build(appID: String, viewPath: String = "/") -> String {
        let normalized: String
        if viewPath.isEmpty {
            normalized = "/"
        } else if viewPath.hasPrefix("/") {
            normalized = viewPath
        } else {
            normalized = "/" + viewPath
        }
        return "https://\(appID)\(normalized)"
    }
}
