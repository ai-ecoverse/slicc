import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdTesting
import HTTPTypes
import NIOCore
import XCTest
@testable import slicc_server

/// Tests for `POST /api/handoff` and the pure Handoff helpers. Mirrors the
/// node-server contract in `packages/node-server/src/routes/handoff.ts`
/// (covered by `packages/node-server/tests/handoff-api.test.ts`): validation
/// error strings must match byte-for-byte (exception: non-object JSON bodies,
/// where the Swift object decode rejects before validation runs — see
/// `testHandoffRouteRejectsNonObjectJsonBodyWithoutBroadcast`), and the
/// broadcast navigate_event must satisfy the wire shape
/// `mapNavigatePayloadToLickEvent` expects (non-empty `verb` / `target` /
/// `url` strings).
final class HandoffTests: XCTestCase {

    // MARK: - validatePayload

    func testValidateAcceptsHandoffPayload() {
        XCTAssertNil(Handoff.validatePayload([
            "verb": .string("handoff"),
            "target": .string("https://example.com/page"),
            "instruction": .string("Continue the signup flow"),
        ]))
    }

    func testValidateAcceptsUpskillWithBranchAndPath() {
        XCTAssertNil(Handoff.validatePayload([
            "verb": .string("upskill"),
            "target": .string("https://github.com/o/r"),
            "branch": .string("main"),
            "path": .string("skills/foo"),
        ]))
    }

    func testValidateRejectsLegacySliccHeader() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "sliccHeader": .string("handoff:do something"),
                "url": .string("about:x"),
            ]),
            "The legacy `sliccHeader` payload was removed; post `{ verb, target, instruction? }` instead. See docs/slicc-handoff.md."
        )
    }

    func testValidateRejectsUnknownVerb() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("launch"),
                "target": .string("https://x.example/"),
            ]),
            "verb must be \"handoff\" or \"upskill\""
        )
    }

    func testValidateRejectsMissingVerb() {
        XCTAssertEqual(
            Handoff.validatePayload(["target": .string("https://x.example/")]),
            "verb must be \"handoff\" or \"upskill\""
        )
    }

    func testValidateRejectsMissingTarget() {
        XCTAssertEqual(
            Handoff.validatePayload(["verb": .string("handoff")]),
            "target is required (non-empty string)"
        )
    }

    func testValidateRejectsEmptyTarget() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("handoff"),
                "target": .string(""),
            ]),
            "target is required (non-empty string)"
        )
    }

    func testValidateRejectsNonStringInstruction() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("handoff"),
                "target": .string("https://x.example/"),
                "instruction": .number(123),
            ]),
            "instruction must be a string when provided"
        )
    }

    func testValidateRejectsNonStringBranch() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("upskill"),
                "target": .string("https://github.com/o/r"),
                "branch": .number(123),
            ]),
            "branch must be a string when provided"
        )
    }

    func testValidateRejectsNonStringPath() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("upskill"),
                "target": .string("https://github.com/o/r"),
                "path": .array([.string("skills"), .string("foo")]),
            ]),
            "path must be a string when provided"
        )
    }

    func testValidateRejectsBranchOnHandoff() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("handoff"),
                "target": .string("https://example.com/"),
                "branch": .string("main"),
            ]),
            "branch and path are only valid with verb=\"upskill\""
        )
    }

    func testValidateRejectsPathOnHandoff() {
        XCTAssertEqual(
            Handoff.validatePayload([
                "verb": .string("handoff"),
                "target": .string("https://example.com/"),
                "path": .string("skills/foo"),
            ]),
            "branch and path are only valid with verb=\"upskill\""
        )
    }

    func testValidateAllowsExplicitNullOptionals() {
        // JSON `null` mirrors the TS `!= null` guards: a null instruction /
        // branch / path is treated as absent, not as a wrong type.
        XCTAssertNil(Handoff.validatePayload([
            "verb": .string("handoff"),
            "target": .string("https://example.com/"),
            "instruction": .null,
            "branch": .null,
            "path": .null,
        ]))
    }

    // MARK: - buildNavigateEvent

    func testBuildFullHandoffEvent() {
        let event = Handoff.buildNavigateEvent([
            "verb": .string("handoff"),
            "target": .string("https://example.com/page"),
            "instruction": .string("Continue the signup flow"),
            "url": .string("https://example.com/page"),
            "title": .string("Signup"),
        ])
        XCTAssertEqual(event["type"], .string("navigate_event"))
        XCTAssertEqual(event["verb"], .string("handoff"))
        XCTAssertEqual(event["target"], .string("https://example.com/page"))
        XCTAssertEqual(event["instruction"], .string("Continue the signup flow"))
        XCTAssertEqual(event["url"], .string("https://example.com/page"))
        XCTAssertEqual(event["title"], .string("Signup"))
        self.assertNodeIsoTimestamp(event["timestamp"]?.stringValue)
    }

    func testBuildDefaultsUrlToAboutHandoffWhenAbsent() {
        let event = Handoff.buildNavigateEvent([
            "verb": .string("handoff"),
            "target": .string("https://example.com/"),
        ])
        XCTAssertEqual(event["url"], .string("about:handoff"))
    }

    func testBuildDefaultsUrlToAboutHandoffWhenEmpty() {
        let event = Handoff.buildNavigateEvent([
            "verb": .string("handoff"),
            "target": .string("https://example.com/"),
            "url": .string(""),
        ])
        XCTAssertEqual(event["url"], .string("about:handoff"))
    }

    func testBuildUpskillCarriesBranchAndPath() {
        let event = Handoff.buildNavigateEvent([
            "verb": .string("upskill"),
            "target": .string("https://github.com/o/r"),
            "branch": .string("main"),
            "path": .string("skills/foo"),
        ])
        XCTAssertEqual(event["verb"], .string("upskill"))
        XCTAssertEqual(event["branch"], .string("main"))
        XCTAssertEqual(event["path"], .string("skills/foo"))
    }

    func testBuildOmitsAbsentOptionals() {
        let event = Handoff.buildNavigateEvent([
            "verb": .string("upskill"),
            "target": .string("https://github.com/o/r"),
            "branch": .string(""),
        ])
        XCTAssertNil(event["instruction"])
        XCTAssertNil(event["title"])
        XCTAssertNil(event["branch"])
        XCTAssertNil(event["path"])
    }

    // MARK: - POST /api/handoff route

    func testHandoffRouteAcceptsHandoffAndBroadcastsNavigateEvent() async throws {
        let recorder = MessageRecorder()
        try await self.withApp(recorder: recorder) { client in
            try await self.postHandoff(
                client,
                body: #"{"verb":"handoff","target":"https://example.com/page","instruction":"Continue the signup flow","url":"https://example.com/page","title":"Signup"}"#
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(try self.decodeJSONObject(from: response.body), ["ok": .bool(true)])
            }
        }
        let frame = try LickSystem.decode(try await recorder.waitForMessage())
        XCTAssertEqual(frame["type"], .string("navigate_event"))
        XCTAssertEqual(frame["verb"], .string("handoff"))
        XCTAssertEqual(frame["target"], .string("https://example.com/page"))
        XCTAssertEqual(frame["instruction"], .string("Continue the signup flow"))
        XCTAssertEqual(frame["url"], .string("https://example.com/page"))
        XCTAssertEqual(frame["title"], .string("Signup"))
        self.assertNodeIsoTimestamp(frame["timestamp"]?.stringValue)
    }

    func testHandoffRouteAcceptsUpskillWithBranchAndPath() async throws {
        let recorder = MessageRecorder()
        try await self.withApp(recorder: recorder) { client in
            try await self.postHandoff(
                client,
                body: #"{"verb":"upskill","target":"https://github.com/o/r","branch":"main","path":"skills/foo"}"#
            ) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(try self.decodeJSONObject(from: response.body), ["ok": .bool(true)])
            }
        }
        let frame = try LickSystem.decode(try await recorder.waitForMessage())
        XCTAssertEqual(frame["verb"], .string("upskill"))
        XCTAssertEqual(frame["target"], .string("https://github.com/o/r"))
        XCTAssertEqual(frame["url"], .string("about:handoff"))
        XCTAssertEqual(frame["branch"], .string("main"))
        XCTAssertEqual(frame["path"], .string("skills/foo"))
        XCTAssertNil(frame["instruction"])
    }

    func testHandoffRouteRejectsLegacySliccHeaderWithoutBroadcast() async throws {
        let recorder = MessageRecorder()
        try await self.withApp(recorder: recorder) { client in
            try await self.postHandoff(
                client,
                body: #"{"sliccHeader":"handoff:do something","url":"about:x"}"#
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(from: response.body)["error"],
                    .string("The legacy `sliccHeader` payload was removed; post `{ verb, target, instruction? }` instead. See docs/slicc-handoff.md.")
                )
            }
        }
        await self.assertNoBroadcast(recorder)
    }

    func testHandoffRouteRejectsUnknownVerb() async throws {
        try await self.withApp { client in
            try await self.postHandoff(
                client,
                body: #"{"verb":"launch","target":"https://x.example/"}"#
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(from: response.body)["error"],
                    .string("verb must be \"handoff\" or \"upskill\"")
                )
            }
        }
    }

    func testHandoffRouteRejectsMissingTarget() async throws {
        try await self.withApp { client in
            try await self.postHandoff(client, body: #"{"verb":"handoff"}"#) { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(from: response.body)["error"],
                    .string("target is required (non-empty string)")
                )
            }
        }
    }

    func testHandoffRouteRejectsBranchOnHandoff() async throws {
        let recorder = MessageRecorder()
        try await self.withApp(recorder: recorder) { client in
            try await self.postHandoff(
                client,
                body: #"{"verb":"handoff","target":"https://example.com/","branch":"main"}"#
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(from: response.body)["error"],
                    .string("branch and path are only valid with verb=\"upskill\"")
                )
            }
        }
        await self.assertNoBroadcast(recorder)
    }

    func testHandoffRouteRejectsMalformedJson() async throws {
        try await self.withApp { client in
            try await self.postHandoff(client, body: "not json") { response in
                XCTAssertEqual(response.status, .badRequest)
            }
        }
    }

    func testHandoffRouteRejectsNonObjectJsonBodyWithoutBroadcast() async throws {
        // Accepted divergence from node-server: express.json parses the array
        // and validation returns the verb error; the Swift object decode
        // rejects first. Both are 400.
        let recorder = MessageRecorder()
        try await self.withApp(recorder: recorder) { client in
            try await self.postHandoff(client, body: "[1,2]") { response in
                XCTAssertEqual(response.status, .badRequest)
                XCTAssertEqual(
                    try self.decodeJSONObject(from: response.body)["error"],
                    .string("Invalid JSON payload")
                )
            }
        }
        await self.assertNoBroadcast(recorder)
    }

    // MARK: - Helpers

    private func withApp(
        recorder: MessageRecorder? = nil,
        _ body: (any TestClientProtocol) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            let lickSystem = LickSystem()
            if let recorder {
                await lickSystem.addClient(WebSocketClient { text in
                    await recorder.append(text)
                })
            }
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: lickSystem,
                config: self.makeConfig(),
                httpClient: httpClient
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router, body)
            try await httpClient.shutdown()
        } catch {
            try? await httpClient.shutdown()
            throw error
        }
    }

    private func postHandoff(
        _ client: any TestClientProtocol,
        body: String,
        _ verify: @escaping (TestResponse) throws -> Void
    ) async throws {
        try await client.execute(
            uri: "/api/handoff",
            method: .post,
            headers: [.contentType: "application/json"],
            body: ByteBuffer(string: body)
        ) { response in
            try verify(response)
        }
    }

    /// Pins the timestamp to node-server's `new Date().toISOString()` byte
    /// format (millisecond precision, `Z` suffix).
    private func assertNodeIsoTimestamp(
        _ timestamp: String?, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let timestamp else {
            XCTFail("timestamp missing", file: file, line: line)
            return
        }
        XCTAssertNotNil(
            timestamp.range(
                of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#,
                options: .regularExpression
            ),
            "timestamp \(timestamp) must match node's toISOString() format",
            file: file,
            line: line
        )
    }

    private func assertNoBroadcast(_ recorder: MessageRecorder) async {
        do {
            let message = try await recorder.waitForMessage(timeout: 0.2)
            XCTFail("no navigate_event must be broadcast on a rejected payload, got: \(message)")
        } catch {
            // Expected: the recorder times out without a message.
        }
    }

    private func makeConfig() -> ServerConfig {
        .init(
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: false,
            leadWorkerBaseUrl: nil,
            leadWorkerBaseURL: nil,
            profile: nil,
            join: false,
            joinUrl: nil,
            joinURL: nil,
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            envFile: nil,
            envFileURL: nil
        )
    }

    private func decodeJSONObject(from body: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: body).utf8))
    }
}
