import XCTest
@testable import SwiftOptel

final class OptelTransportTests: XCTestCase {
    private let baseURL = URL(string: "https://rum.hlx.page/")!

    private func sampleEvent(weight: Int = 100) -> RUMEvent {
        RUMEvent(
            weight: weight,
            id: "abc123def",
            referer: "https://com.example.app/home",
            checkpoint: .click,
            t: 1234,
            pingData: RUMPingData(source: ".button#submit", target: "/api/checkout", value: 42)
        )
    }

    func testMakeRequestBuildsCollectorURLWithWeight() throws {
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: sampleEvent(weight: 100),
            collectBaseURL: baseURL,
            timeout: 10
        ))
        XCTAssertEqual(request.url?.absoluteString, "https://rum.hlx.page/.rum/100")
    }

    func testMakeRequestHonorsCustomWeightInPath() throws {
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: sampleEvent(weight: 1000),
            collectBaseURL: baseURL,
            timeout: 10
        ))
        XCTAssertEqual(request.url?.absoluteString, "https://rum.hlx.page/.rum/1000")
    }

    func testMakeRequestHonorsCustomBaseURL() throws {
        let base = URL(string: "https://custom.example.com/path/")!
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: sampleEvent(),
            collectBaseURL: base,
            timeout: 10
        ))
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://custom.example.com/path/.rum/100"
        )
    }

    func testMakeRequestSetsPostMethodAndJSONHeader() throws {
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: sampleEvent(),
            collectBaseURL: baseURL,
            timeout: 10
        ))
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testMakeRequestPropagatesTimeout() throws {
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: sampleEvent(),
            collectBaseURL: baseURL,
            timeout: 3.5
        ))
        XCTAssertEqual(request.timeoutInterval, 3.5, accuracy: 0.0001)
    }

    func testMakeRequestEncodesEventAsBody() throws {
        let event = sampleEvent()
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: event,
            collectBaseURL: baseURL,
            timeout: 10
        ))
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(json["weight"] as? Int, 100)
        XCTAssertEqual(json["id"] as? String, "abc123def")
        XCTAssertEqual(json["referer"] as? String, "https://com.example.app/home")
        XCTAssertEqual(json["checkpoint"] as? String, "click")
        XCTAssertEqual(json["t"] as? Int, 1234)
        XCTAssertEqual(json["source"] as? String, ".button#submit")
        XCTAssertEqual(json["target"] as? String, "/api/checkout")
        XCTAssertEqual(json["value"] as? Double, 42)
    }

    func testBodyRefererHostMatchesAppIDFromBuilder() throws {
        let referer = RUMReferer.build(appID: "com.example.app", viewPath: "/home")
        let event = RUMEvent(
            weight: 100,
            id: "abc123def",
            referer: referer,
            checkpoint: .top,
            t: 0
        )
        let request = try XCTUnwrap(URLSessionOptelTransport.makeRequest(
            event: event,
            collectBaseURL: baseURL,
            timeout: 10
        ))
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        let bodyReferer = try XCTUnwrap(json["referer"] as? String)
        let components = try XCTUnwrap(URLComponents(string: bodyReferer))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "com.example.app")
        XCTAssertEqual(components.path, "/home")
    }

    func testSendThroughMockTransportDoesNotThrowAndRecordsInputs() {
        let mock = RecordingTransport()
        mock.send(sampleEvent(), collectBaseURL: baseURL)
        XCTAssertEqual(mock.sent.count, 1)
        XCTAssertEqual(mock.sent.first?.event.id, "abc123def")
        XCTAssertEqual(mock.sent.first?.baseURL, baseURL)
    }

    func testSendIsFireAndForgetAndNonBlocking() {
        // Use an unreachable URL via a mock URLProtocol to verify the call
        // returns promptly even when the network errors out.
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailingURLProtocol.self]
        let session = URLSession(configuration: config)
        let transport = URLSessionOptelTransport(session: session, timeout: 1)
        let start = Date()
        transport.send(sampleEvent(), collectBaseURL: baseURL)
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
    }

    func testDebugLoggingEnabledTransportStillFireAndForget() {
        // With debugLogging=true the transport additionally emits os.Logger
        // entries; behavior on the wire (and the swallow-on-error contract)
        // must be unchanged. We can't observe the os.Logger sink directly,
        // so the assertion is "no blocking, no crash".
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailingURLProtocol.self]
        let session = URLSession(configuration: config)
        let transport = URLSessionOptelTransport(
            session: session,
            timeout: 1,
            debugLogging: true
        )
        let start = Date()
        transport.send(sampleEvent(), collectBaseURL: baseURL)
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
    }

    func testDebugLoggingDefaultsToOff() {
        // The default initializer must keep the no-logging behavior so
        // existing callers see no change.
        let transport = URLSessionOptelTransport()
        // No public way to introspect the flag; success is "constructs and
        // sends" with the same fire-and-forget contract.
        transport.send(sampleEvent(), collectBaseURL: baseURL)
    }

    func testLoggerSubsystemAndCategoryAreStable() {
        // These constants are part of the documented public surface so users
        // can filter log streams (e.g. `log show --predicate
        // 'subsystem == "com.slicc.swift-optel"'`).
        XCTAssertEqual(URLSessionOptelTransport.loggerSubsystem, "com.slicc.swift-optel")
        XCTAssertEqual(URLSessionOptelTransport.loggerCategory, "transport")
    }
}

/// `URLProtocol` that fails every request synchronously. Used to confirm the
/// transport swallows errors and never blocks.
private final class FailingURLProtocol: URLProtocol {
    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
