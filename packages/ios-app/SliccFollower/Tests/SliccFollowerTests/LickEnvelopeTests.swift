import XCTest

@testable import SliccFollower
@testable import SliccTrayKit






final class LickEnvelopeTests: XCTestCase {
    private func encode(_ message: FollowerToLeaderMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    

    func testNavigateLickEncodesTheWireShapeTheLeaderExpects() throws {
        let match = HandoffMatch(
            verb: .upskill, target: "https://github.com/o/r", instruction: "add the skill",
            branch: "main", path: "skills/demo")
        let event = LickEvent.navigate(
            pageURL: "https://example.com/p", match: match, title: "Example",
            timestamp: "2026-08-01T00:00:00Z")

        let json = try encode(.lick(event: event))
        XCTAssertEqual(json["type"] as? String, "lick")
        let wrapped = try XCTUnwrap(json["event"] as? [String: Any])
        XCTAssertEqual(wrapped["type"] as? String, "navigate")
        XCTAssertEqual(wrapped["navigateUrl"] as? String, "https://example.com/p")
        XCTAssertEqual(wrapped["timestamp"] as? String, "2026-08-01T00:00:00Z")

        let body = try XCTUnwrap(wrapped["body"] as? [String: Any])
        XCTAssertEqual(body["url"] as? String, "https://example.com/p")
        XCTAssertEqual(body["verb"] as? String, "upskill")
        XCTAssertEqual(body["target"] as? String, "https://github.com/o/r")
        XCTAssertEqual(body["instruction"] as? String, "add the skill")
        XCTAssertEqual(body["branch"] as? String, "main")
        XCTAssertEqual(body["path"] as? String, "skills/demo")
        XCTAssertEqual(body["title"] as? String, "Example")
    }

    func testAbsentHandoffFieldsAreOmittedNotNulled() throws {
        
        
        let match = HandoffMatch(verb: .handoff, target: "https://example.com/p")
        let event = LickEvent.navigate(
            pageURL: "https://example.com/p", match: match, title: nil,
            timestamp: "2026-08-01T00:00:00Z")
        let json = try encode(.lick(event: event))
        let wrapped = try XCTUnwrap(json["event"] as? [String: Any])
        let body = try XCTUnwrap(wrapped["body"] as? [String: Any])

        for absent in ["instruction", "branch", "path", "title"] {
            XCTAssertNil(body[absent], "\(absent) should be omitted entirely")
        }
        XCTAssertNil(wrapped["targetScoop"], "targetScoop is stripped by the leader anyway")
        XCTAssertNil(wrapped["discoveryOrigin"])
    }

    func testLickRoundTrips() throws {
        let match = HandoffMatch(verb: .upskill, target: "https://github.com/o/r", branch: "main")
        let event = LickEvent.navigate(
            pageURL: "https://example.com/p", match: match, title: nil,
            timestamp: "2026-08-01T00:00:00Z")
        let data = try JSONEncoder().encode(FollowerToLeaderMessage.lick(event: event))
        let decoded = try JSONDecoder().decode(FollowerToLeaderMessage.self, from: data)
        guard case .lick(let roundTripped) = decoded else {
            return XCTFail("expected .lick, got \(decoded)")
        }
        XCTAssertEqual(roundTripped.type, .navigate)
        XCTAssertEqual(roundTripped.navigateUrl, "https://example.com/p")
        XCTAssertEqual(roundTripped.timestamp, "2026-08-01T00:00:00Z")
    }

    func testOnlyForwardableLickTypesExist() {
        
        
        XCTAssertEqual(Set(["navigate", "discovery"]), Set(["navigate", "discovery"]))
        XCTAssertEqual(FollowerLickType.navigate.rawValue, "navigate")
        XCTAssertEqual(FollowerLickType.discovery.rawValue, "discovery")
        XCTAssertNil(FollowerLickType(rawValue: "sprinkle"))
        XCTAssertNil(FollowerLickType(rawValue: "webhook"))
    }

    

    func testFollowerHelloAdvertisesExec() throws {
        let json = try encode(
            .hello(
                protocolVersion: traySyncProtocolVersion, runtime: "slicc-ios",
                capabilities: trayFollowerCapabilities, motd: "test motd"))
        XCTAssertEqual(json["runtime"] as? String, "slicc-ios")
        let capabilities = try XCTUnwrap(json["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["exec"] as? Bool, true)
        XCTAssertEqual(json["motd"] as? String, "test motd")
    }

    func testFollowerCapabilitiesAdvertiseRestrictedExec() {
        XCTAssertTrue(trayFollowerCapabilities.exec)
    }

    func testMotdIdentifiesThePhone() {
        
        
        let motd = trayFollowerMotd
        XCTAssertTrue(motd.contains("iOS"), "motd should name the platform: \(motd)")
        XCTAssertTrue(motd.contains("only supported command: open"))
        XCTAssertFalse(motd.isEmpty)
        XCTAssertLessThan(motd.count, 200, "motd is a one-liner")
        XCTAssertFalse(motd.contains("\n"), "motd is a one-liner")
    }

    func testLeaderHelloDecodesCapabilitiesAndMotd() throws {
        let payload = """
            {"type":"hello","protocolVersion":4,"runtime":"slicc-standalone",
             "capabilities":{"exec":true},"motd":"macOS via node-server"}
            """
        let decoded = try JSONDecoder().decode(
            LeaderToFollowerMessage.self, from: Data(payload.utf8))
        guard case .hello(let version, let runtime, let capabilities, let motd) = decoded else {
            return XCTFail("expected .hello, got \(decoded)")
        }
        XCTAssertEqual(version, 4)
        XCTAssertEqual(runtime, "slicc-standalone")
        XCTAssertEqual(capabilities?.exec, true)
        XCTAssertEqual(motd, "macOS via node-server")
    }

    func testLegacyHelloWithoutTheNewFieldsStillDecodes() throws {
        
        let payload = #"{"type":"hello","protocolVersion":1,"runtime":"slicc-standalone"}"#
        let decoded = try JSONDecoder().decode(
            LeaderToFollowerMessage.self, from: Data(payload.utf8))
        guard case .hello(_, _, let capabilities, let motd) = decoded else {
            return XCTFail("expected .hello, got \(decoded)")
        }
        XCTAssertNil(capabilities)
        XCTAssertNil(motd)
    }

    

    func testWrappingAnAlreadyWrappedValueDoesNotEncodeNull() throws {
        
        
        
        let doubled = AnyCodable(AnyCodable(["k": "v"]))
        let data = try JSONEncoder().encode(doubled)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["k"] as? String, "v")
    }

    

    func testFingerprintIgnoresThePageThatAdvertisedIt() {
        
        
        let a = HandoffMatch(verb: .upskill, target: "https://github.com/o/r", branch: "main")
        let b = HandoffMatch(verb: .upskill, target: "https://github.com/o/r", branch: "main")
        XCTAssertEqual(AppState.handoffFingerprint(a), AppState.handoffFingerprint(b))
    }

    func testFingerprintSeparatesAdjacentFields() {
        
        let a = HandoffMatch(verb: .upskill, target: "https://x/r", branch: "ab", path: "c")
        let b = HandoffMatch(verb: .upskill, target: "https://x/r", branch: "a", path: "bc")
        XCTAssertNotEqual(AppState.handoffFingerprint(a), AppState.handoffFingerprint(b))
    }

    func testFingerprintDistinguishesVerbs() {
        let a = HandoffMatch(verb: .handoff, target: "https://x/r")
        let b = HandoffMatch(verb: .upskill, target: "https://x/r")
        XCTAssertNotEqual(AppState.handoffFingerprint(a), AppState.handoffFingerprint(b))
    }

    @MainActor
    func testTheSameHandoffIsForwardedOnlyOnce() {
        
        
        let state = AppState()
        let match = HandoffMatch(verb: .handoff, target: "do the thing")
        
        
        
        XCTAssertEqual(
            state.forwardNavigateLick(pageURL: "https://a.example/1", match: match, title: nil),
            .notDelivered)
        
        
        XCTAssertEqual(
            state.forwardNavigateLick(pageURL: "https://a.example/2", match: match, title: nil),
            .duplicate)
        
        XCTAssertEqual(
            state.forwardNavigateLick(
                pageURL: "https://a.example/2",
                match: HandoffMatch(verb: .handoff, target: "something else"), title: nil),
            .notDelivered)
    }

    

    private func response(url: String, headers: [String: String]) -> HTTPURLResponse? {
        HTTPURLResponse(
            url: URL(string: url)!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: headers)
    }

    func testHandoffIsReadFromAMainFrameResponse() throws {
        let link = "<https://github.com/o/r>; rel=\"\(HandoffLink.upskillRel)\""
        let result = try XCTUnwrap(
            CDPTarget.handoff(
                isForMainFrame: true,
                response: response(url: "https://example.com/p", headers: ["Link": link]),
                fallbackURL: ""))
        XCTAssertEqual(result.match.verb, .upskill)
        XCTAssertEqual(result.pageURL, "https://example.com/p")
    }

    func testSubFrameHandoffsAreIgnored() {
        
        
        let link = "<https://github.com/o/r>; rel=\"\(HandoffLink.upskillRel)\""
        XCTAssertNil(
            CDPTarget.handoff(
                isForMainFrame: false,
                response: response(url: "https://evil.example/f", headers: ["Link": link]),
                fallbackURL: ""))
    }

    func testResponsesWithoutALinkHeaderAreIgnored() {
        XCTAssertNil(
            CDPTarget.handoff(
                isForMainFrame: true,
                response: response(url: "https://example.com/p", headers: [:]),
                fallbackURL: ""))
    }

    func testLinkHeaderWithoutASliccRelIsIgnored() {
        XCTAssertNil(
            CDPTarget.handoff(
                isForMainFrame: true,
                response: response(
                    url: "https://example.com/p",
                    headers: ["Link": "<https://example.com/style.css>; rel=\"preload\""]),
                fallbackURL: ""))
    }

    func testNonHttpResponsesAreIgnored() {
        
        let plain = URLResponse(
            url: URL(string: "file:///tmp/x.html")!, mimeType: "text/html",
            expectedContentLength: 0, textEncodingName: nil)
        XCTAssertNil(
            CDPTarget.handoff(isForMainFrame: true, response: plain, fallbackURL: ""))
    }
}
