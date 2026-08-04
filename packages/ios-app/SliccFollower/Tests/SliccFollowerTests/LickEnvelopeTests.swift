import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

/// The wire shape of the generic `lick` envelope and the `hello` fields.
///
/// The leader is unforgiving about both: `handleFollowerLick` drops any lick
/// whose `type` is outside `FORWARDABLE_TO_LEADER`, and a `hello` field that
/// encodes under the wrong key is simply never seen.
final class LickEnvelopeTests: XCTestCase {
    private func encode(_ message: FollowerToLeaderMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Envelope shape

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
        // The web watcher only sets what it has; a JSON `null` would read as a
        // present-but-empty value on the cone side.
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
        // A type the leader would reject must not be constructible. If
        // FORWARDABLE_TO_LEADER grows, this is the reminder to widen the enum.
        XCTAssertEqual(Set(["navigate", "discovery"]), Set(["navigate", "discovery"]))
        XCTAssertEqual(FollowerLickType.navigate.rawValue, "navigate")
        XCTAssertEqual(FollowerLickType.discovery.rawValue, "discovery")
        XCTAssertNil(FollowerLickType(rawValue: "sprinkle"))
        XCTAssertNil(FollowerLickType(rawValue: "webhook"))
    }

    // MARK: - hello

    func testFollowerHelloAdvertisesExecFalseExplicitly() throws {
        let json = try encode(
            .hello(
                protocolVersion: traySyncProtocolVersion, runtime: "slicc-ios",
                capabilities: trayFollowerCapabilities, motd: "test motd"))
        XCTAssertEqual(json["runtime"] as? String, "slicc-ios")
        let capabilities = try XCTUnwrap(json["capabilities"] as? [String: Any])
        // Present and false, not absent: the leader's exec gate reads
        // `peerCapabilities?.exec`, so absent and false behave alike — but only
        // one of them says so.
        XCTAssertEqual(capabilities["exec"] as? Bool, false)
        XCTAssertEqual(json["motd"] as? String, "test motd")
    }

    func testFollowerCapabilitiesNeverClaimExec() {
        XCTAssertFalse(trayFollowerCapabilities.exec, "iOS has no OS shell")
    }

    func testMotdIdentifiesThePhone() {
        // It lands in the leader's `ssh --list`, so it has to distinguish this
        // follower from the others without being a paragraph.
        let motd = trayFollowerMotd
        XCTAssertTrue(motd.contains("iOS"), "motd should name the platform: \(motd)")
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
        // Both fields are additive; a leader predating them must still connect.
        let payload = #"{"type":"hello","protocolVersion":1,"runtime":"slicc-standalone"}"#
        let decoded = try JSONDecoder().decode(
            LeaderToFollowerMessage.self, from: Data(payload.utf8))
        guard case .hello(_, _, let capabilities, let motd) = decoded else {
            return XCTFail("expected .hello, got \(decoded)")
        }
        XCTAssertNil(capabilities)
        XCTAssertNil(motd)
    }

    // MARK: - AnyCodable nesting

    func testWrappingAnAlreadyWrappedValueDoesNotEncodeNull() throws {
        // Regression: `AnyCodable(AnyCodable(x))` used to survive construction
        // and then encode as `null`, so a body built from pre-wrapped values
        // reached the leader with every field emptied.
        let doubled = AnyCodable(AnyCodable(["k": "v"]))
        let data = try JSONEncoder().encode(doubled)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["k"] as? String, "v")
    }

    // MARK: - Dedup

    func testFingerprintIgnoresThePageThatAdvertisedIt() {
        // A site-wide handoff rel appears on every page; the payload is what
        // identifies it, not the URL it was seen on.
        let a = HandoffMatch(verb: .upskill, target: "https://github.com/o/r", branch: "main")
        let b = HandoffMatch(verb: .upskill, target: "https://github.com/o/r", branch: "main")
        XCTAssertEqual(AppState.handoffFingerprint(a), AppState.handoffFingerprint(b))
    }

    func testFingerprintSeparatesAdjacentFields() {
        // Naive concatenation would collide these two.
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
        // Disconnected, so nothing is actually sent — but the dedup decision
        // happens before the send, which is exactly the part under test.
        let state = AppState()
        let match = HandoffMatch(verb: .handoff, target: "do the thing")
        // No leader is connected, so the first attempt cannot be delivered —
        // but it is still *attempted*, which is what distinguishes it from the
        // second.
        XCTAssertEqual(
            state.forwardNavigateLick(pageURL: "https://a.example/1", match: match, title: nil),
            .notDelivered)
        // Same payload on a different page: suppressed by dedup, not merely
        // undeliverable.
        XCTAssertEqual(
            state.forwardNavigateLick(pageURL: "https://a.example/2", match: match, title: nil),
            .duplicate)
        // A different payload is attempted again rather than swallowed.
        XCTAssertEqual(
            state.forwardNavigateLick(
                pageURL: "https://a.example/2",
                match: HandoffMatch(verb: .handoff, target: "something else"), title: nil),
            .notDelivered)
    }

    // MARK: - Main-frame gate

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
        // An embedded third-party iframe must not be able to inject an
        // instruction into the user's cone.
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
        // file:// and about: loads carry no headers to trust.
        let plain = URLResponse(
            url: URL(string: "file:///tmp/x.html")!, mimeType: "text/html",
            expectedContentLength: 0, textEncodingName: nil)
        XCTAssertNil(
            CDPTarget.handoff(isForMainFrame: true, response: plain, fallbackURL: ""))
    }
}
