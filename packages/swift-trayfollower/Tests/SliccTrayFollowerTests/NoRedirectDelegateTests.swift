import XCTest

@testable import SliccTrayFollower

/// The delegate that keeps the hub's supersede 308 visible (#1957). Without it
/// `URLSession` follows the redirect and the probe never learns the tray moved.
final class NoRedirectDelegateTests: XCTestCase {
    func testRefusesTheProposedRedirectRequest() {
        let delegate = NoRedirectDelegate()
        let session = URLSession(configuration: .ephemeral)
        let old = URL(string: "https://www.sliccy.ai/join/old.secret")!
        let redirect = HTTPURLResponse(
            url: old, statusCode: 308, httpVersion: "HTTP/1.1",
            headerFields: ["Location": "https://www.sliccy.ai/join/fresh.beef"])!

        var handlerCalled = false
        var proposed: URLRequest? = URLRequest(url: old)
        delegate.urlSession(
            session,
            task: session.dataTask(with: old),
            willPerformHTTPRedirection: redirect,
            newRequest: URLRequest(url: URL(string: "https://www.sliccy.ai/join/fresh.beef")!)
        ) { request in
            handlerCalled = true
            proposed = request
        }

        XCTAssertTrue(handlerCalled)
        // nil hands the 3xx back to the caller, headers and body intact.
        XCTAssertNil(proposed)
        session.invalidateAndCancel()
    }
}
