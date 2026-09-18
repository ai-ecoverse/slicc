import XCTest

@testable import SliccTraySession



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
        
        XCTAssertNil(proposed)
        session.invalidateAndCancel()
    }
}
