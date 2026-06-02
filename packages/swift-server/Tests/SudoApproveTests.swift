import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import XCTest
@testable import slicc_server

/// Tests for the `/api/sudo-approve` handler and its helpers. Mirrors the
/// behavior covered by the node-server tests for `dialog-backends.ts` +
/// `endpoint.ts`, adapted to the Swift handler. The osascript runner is
/// injected so no real dialog is spawned: the decision tests assert parsing
/// and fail-closed behavior, and the argv test asserts the script contents.
final class SudoApproveTests: XCTestCase {

    private func request(
        kind: String = "command",
        detail: String = "rm -rf /tmp/x",
        suggestedPattern: String? = nil
    ) -> SudoApprove.ApproveRequest {
        SudoApprove.ApproveRequest(kind: kind, detail: detail, suggestedPattern: suggestedPattern)
    }

    // MARK: - decision parsing

    func testAllowOnceReturnsAllow() async {
        let runner: SudoApprove.OsascriptRunner = { _ in "button returned:Allow Once" }
        let decision = await SudoApprove.decide(request: self.request(), runner: runner)
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "allow", pattern: nil))
    }

    func testAlwaysWithEditedTextReturnsAlwaysWithThatPattern() async {
        let runner: SudoApprove.OsascriptRunner = { _ in
            "button returned:Always, text returned:rm -rf *"
        }
        let decision = await SudoApprove.decide(request: self.request(), runner: runner)
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "always", pattern: "rm -rf *"))
    }

    func testAlwaysWithEmptyTextFallsBackToSuggested() async {
        let runner: SudoApprove.OsascriptRunner = { _ in
            "button returned:Always, text returned:"
        }
        let decision = await SudoApprove.decide(
            request: self.request(suggestedPattern: "rm -rf /tmp/*"),
            runner: runner
        )
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "always", pattern: "rm -rf /tmp/*"))
    }

    func testDenyButtonReturnsDeny() async {
        let runner: SudoApprove.OsascriptRunner = { _ in "button returned:Deny" }
        let decision = await SudoApprove.decide(request: self.request(), runner: runner)
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "deny", pattern: nil))
    }

    func testDismissedDialogThrowsAndFailsClosed() async {
        let runner: SudoApprove.OsascriptRunner = { _ in
            throw SudoApprove.SudoApproveError.nonZeroExit(code: -128)
        }
        let decision = await SudoApprove.decide(request: self.request(), runner: runner)
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "deny", pattern: nil))
    }

    func testUnparsableOutputFailsClosed() async {
        let runner: SudoApprove.OsascriptRunner = { _ in "garbage with no button" }
        let decision = await SudoApprove.decide(request: self.request(), runner: runner)
        XCTAssertEqual(decision, SudoApprove.Decision(decision: "deny", pattern: nil))
    }

    // MARK: - script contents

    func testScriptContainsButtonsAndTitle() async {
        actor ArgvBox {
            var args: [String] = []
            func set(_ a: [String]) { self.args = a }
        }
        let box = ArgvBox()
        let runner: SudoApprove.OsascriptRunner = { args in
            await box.set(args)
            return "button returned:Allow Once"
        }
        _ = await SudoApprove.decide(
            request: self.request(kind: "write", detail: "config.json"),
            runner: runner
        )
        let args = await box.args
        XCTAssertEqual(args.first, "-e")
        let script = args.count > 1 ? args[1] : ""
        XCTAssertTrue(script.contains("\"Deny\""))
        XCTAssertTrue(script.contains("\"Allow Once\""))
        XCTAssertTrue(script.contains("\"Always\""))
        XCTAssertTrue(script.contains("with title \"SLICC sudo\""))
        XCTAssertTrue(script.contains("default button \"Allow Once\""))
        XCTAssertTrue(script.contains("write: config.json"))
    }

    // MARK: - HTTP envelope validation

    private func badRequestRunner(file: StaticString = #filePath, line: UInt = #line) -> SudoApprove.OsascriptRunner {
        { _ in
            XCTFail("runner must not be invoked for an invalid envelope", file: file, line: line)
            return ""
        }
    }

    func testHandlerRejectsInvalidKind() async throws {
        try await self.runEnvelope(
            body: #"{"kind":"bogus","detail":"x"}"#,
            expectInvalid: true
        )
    }

    func testHandlerRejectsEmptyDetail() async throws {
        try await self.runEnvelope(
            body: #"{"kind":"command","detail":""}"#,
            expectInvalid: true
        )
    }

    func testHandlerAcceptsValidEnvelope() async throws {
        try await self.runEnvelope(
            body: #"{"kind":"command","detail":"ls"}"#,
            expectInvalid: false
        )
    }

    private func runEnvelope(body: String, expectInvalid: Bool) async throws {
        let router = Router()
        let runner: SudoApprove.OsascriptRunner = expectInvalid
            ? self.badRequestRunner()
            : { @Sendable _ in "button returned:Allow Once" }
        SudoApprove.registerRoutes(router: router, runner: runner)
        let app = Application(responder: router.buildResponder())
        try await app.test(.router) { client in
            try await client.execute(
                uri: "/api/sudo-approve",
                method: .post,
                headers: [.contentType: "application/json"],
                body: ByteBuffer(string: body)
            ) { response in
                if expectInvalid {
                    XCTAssertEqual(response.status, .badRequest)
                } else {
                    XCTAssertEqual(response.status, .ok)
                    let obj = try JSONDecoder().decode(
                        LickSystem.JSONObject.self,
                        from: Data(String(buffer: response.body).utf8)
                    )
                    XCTAssertEqual(obj["decision"], .string("allow"))
                }
            }
        }
    }
}
