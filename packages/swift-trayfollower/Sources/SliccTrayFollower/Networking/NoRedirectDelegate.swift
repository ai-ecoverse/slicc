import Foundation

/// A `URLSession` delegate that reports an HTTP redirect instead of following
/// it, so the caller sees the 3xx response itself — status, `Location`, `Link`
/// and body intact.
///
/// The tray hub answers a superseded tray with `308` (#1957). `URLSession`
/// follows that transparently and re-POSTs the body, which connects but hides
/// the hop: the consumer never learns the tray's address changed, so it keeps
/// the dead join URL and re-walks the redirect on every reconnect for the rest
/// of the session. Suppressing the follow also keeps the hop bound and the
/// per-hop timeout ours rather than the platform's.
///
/// Twin of the file in `packages/swift-traysession`, duplicated for the same
/// reason `SupersedeLink` is: that package stays Foundation-only and depends on
/// nothing. The two move together.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    // Stateless, so concurrent delegate callbacks have nothing to race on.

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
