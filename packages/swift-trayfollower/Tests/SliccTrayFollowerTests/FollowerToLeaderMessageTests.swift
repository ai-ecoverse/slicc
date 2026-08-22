import Foundation
import XCTest

@testable import SliccTrayFollower

/// Round-trips of every `FollowerToLeaderMessage` variant, plus the two
/// wire-optional encode subtleties (`steer`, empty `attachments`) and the
/// throwing unknown-type path.
final class FollowerToLeaderMessageTests: XCTestCase {

    private func roundTrip(_ message: FollowerToLeaderMessage) throws -> FollowerToLeaderMessage {
        try WireCodec.roundTrip(message)
    }

    // MARK: - user_message

    func testUserMessageDefaultsOmitSteerAndAttachments() throws {
        let json = try WireCodec.jsonString(FollowerToLeaderMessage.userMessage(text: "hi", messageId: "m1"))
        XCTAssertFalse(json.contains("steer"))
        XCTAssertFalse(json.contains("attachments"))

        guard
            case .userMessage(let text, let messageId, let steer, let attachments) =
                try roundTrip(.userMessage(text: "hi", messageId: "m1"))
        else {
            XCTFail("expected userMessage")
            return
        }
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(messageId, "m1")
        XCTAssertFalse(steer)
        XCTAssertNil(attachments)
    }

    func testUserMessageWithSteerAndAttachments() throws {
        let attachment = MessageAttachment(id: "a1", name: "f.txt", mimeType: "text/plain", size: 3, kind: .text, text: "abc")
        guard
            case .userMessage(let text, _, let steer, let attachments) =
                try roundTrip(.userMessage(text: "go", messageId: "m2", steer: true, attachments: [attachment]))
        else {
            XCTFail("expected userMessage")
            return
        }
        XCTAssertEqual(text, "go")
        XCTAssertTrue(steer)
        XCTAssertEqual(attachments, [attachment])
    }

    func testUserMessageEmptyAttachmentsOmitted() throws {
        // An empty (but non-nil) attachments array must not appear on the wire.
        let json = try WireCodec.jsonString(FollowerToLeaderMessage.userMessage(text: "hi", messageId: "m1", attachments: []))
        XCTAssertFalse(json.contains("attachments"))
    }

    // MARK: - session control

    func testNewSessionAllDispositions() throws {
        for action in [NewSessionAction.save, .skip, .erase] {
            guard case .newSession(let decoded) = try roundTrip(.newSession(action: action)) else {
                XCTFail("expected newSession")
                return
            }
            XCTAssertEqual(decoded, action)
        }
    }

    func testAbortRoundTrip() throws {
        guard case .abort = try roundTrip(.abort) else {
            XCTFail("expected abort")
            return
        }
    }

    func testRequestSnapshotWithAndWithoutScoop() throws {
        guard case .requestSnapshot(let scoopJid) = try roundTrip(.requestSnapshot(scoopJid: "s1")) else {
            XCTFail("expected requestSnapshot")
            return
        }
        XCTAssertEqual(scoopJid, "s1")

        guard case .requestSnapshot(let none) = try roundTrip(.requestSnapshot(scoopJid: nil)) else {
            XCTFail("expected requestSnapshot")
            return
        }
        XCTAssertNil(none)
    }

    func testScoopsSelectRoundTrip() throws {
        guard case .scoopsSelect(let scoopJid) = try roundTrip(.scoopsSelect(scoopJid: "s1")) else {
            XCTFail("expected scoopsSelect")
            return
        }
        XCTAssertEqual(scoopJid, "s1")
    }

    // MARK: - models / thinking

    func testModelsRequestRoundTrip() throws {
        guard case .modelsRequest = try roundTrip(.modelsRequest) else {
            XCTFail("expected modelsRequest")
            return
        }
    }

    func testModelSelectRoundTrip() throws {
        guard case .modelSelect(let modelId) = try roundTrip(.modelSelect(modelId: "claude-x")) else {
            XCTFail("expected modelSelect")
            return
        }
        XCTAssertEqual(modelId, "claude-x")
    }

    func testThinkingSetWithEffortOverride() throws {
        guard
            case .thinkingSet(let scoopJid, let level, let effort) =
                try roundTrip(.thinkingSet(scoopJid: "s1", thinkingLevel: .xhigh, effortOverride: "max"))
        else {
            XCTFail("expected thinkingSet")
            return
        }
        XCTAssertEqual(scoopJid, "s1")
        XCTAssertEqual(level, .xhigh)
        XCTAssertEqual(effort, "max")
    }

    func testThinkingSetWithoutEffortOverride() throws {
        guard
            case .thinkingSet(_, let level, let effort) =
                try roundTrip(.thinkingSet(scoopJid: "s1", thinkingLevel: .off, effortOverride: nil))
        else {
            XCTFail("expected thinkingSet")
            return
        }
        XCTAssertEqual(level, .off)
        XCTAssertNil(effort)
    }

    // MARK: - sprinkles

    func testSprinklesRefreshRoundTrip() throws {
        guard case .sprinklesRefresh = try roundTrip(.sprinklesRefresh) else {
            XCTFail("expected sprinklesRefresh")
            return
        }
    }

    func testSprinkleFetchRoundTrip() throws {
        guard case .sprinkleFetch(let requestId, let name) = try roundTrip(.sprinkleFetch(requestId: "r1", sprinkleName: "s")) else {
            XCTFail("expected sprinkleFetch")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(name, "s")
    }

    func testSprinkleLickRoundTrip() throws {
        let body = try WireCodec.anyCodable(#"{"clicked":true}"#)
        guard
            case .sprinkleLick(let name, let decodedBody, let targetScoop) =
                try roundTrip(.sprinkleLick(sprinkleName: "s", body: body, targetScoop: "j1"))
        else {
            XCTFail("expected sprinkleLick")
            return
        }
        XCTAssertEqual(name, "s")
        XCTAssertEqual(decodedBody, body)
        XCTAssertEqual(targetScoop, "j1")
    }

    func testSprinkleLickWithoutOptionalFields() throws {
        guard
            case .sprinkleLick(_, let body, let targetScoop) =
                try roundTrip(.sprinkleLick(sprinkleName: "s", body: nil, targetScoop: nil))
        else {
            XCTFail("expected sprinkleLick")
            return
        }
        XCTAssertNil(body)
        XCTAssertNil(targetScoop)
    }

    // MARK: - targets / CDP reply path

    func testTargetsAdvertiseRoundTrip() throws {
        let target = RemoteTargetInfo(
            targetId: "t1", title: "Tab", url: "https://x", kind: "cherry",
            capabilities: CherryCapabilities(navigate: true, network: true, screenshot: false))
        guard
            case .targetsAdvertise(let targets, let runtimeId) =
                try roundTrip(.targetsAdvertise(targets: [target], runtimeId: "runtime-1"))
        else {
            XCTFail("expected targetsAdvertise")
            return
        }
        XCTAssertEqual(targets, [target])
        XCTAssertEqual(runtimeId, "runtime-1")
    }

    func testCdpRequestRoundTrip() throws {
        let params = try WireCodec.anyCodable(#"{"depth":1}"#)
        guard
            case .cdpRequest(let requestId, let targetRuntimeId, let localTargetId, let method, let decodedParams, let sessionId) =
                try roundTrip(
                    .cdpRequest(
                        requestId: "r1", targetRuntimeId: "leader", localTargetId: "t1",
                        method: "DOM.getDocument", params: params, sessionId: nil))
        else {
            XCTFail("expected cdpRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(targetRuntimeId, "leader")
        XCTAssertEqual(localTargetId, "t1")
        XCTAssertEqual(method, "DOM.getDocument")
        XCTAssertEqual(decodedParams, params)
        XCTAssertNil(sessionId)
    }

    func testCdpResponseRoundTrip() throws {
        guard
            case .cdpResponse(let requestId, let result, let error, let chunkData, let chunkIndex, let totalChunks) =
                try roundTrip(.cdpResponse(requestId: "r1", result: nil, error: "denied", chunkData: nil, chunkIndex: nil, totalChunks: nil))
        else {
            XCTFail("expected cdpResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertNil(result)
        XCTAssertEqual(error, "denied")
        XCTAssertNil(chunkData)
        XCTAssertNil(chunkIndex)
        XCTAssertNil(totalChunks)
    }

    func testCdpEventRoundTrip() throws {
        let params = try WireCodec.anyCodable(#"{"frameId":"f1"}"#)
        guard
            case .cdpEvent(let method, let decodedParams, let sessionId) =
                try roundTrip(.cdpEvent(method: "Page.frameNavigated", params: params, sessionId: "sess"))
        else {
            XCTFail("expected cdpEvent")
            return
        }
        XCTAssertEqual(method, "Page.frameNavigated")
        XCTAssertEqual(decodedParams, params)
        XCTAssertEqual(sessionId, "sess")
    }

    func testTabOpenedRoundTrip() throws {
        guard case .tabOpened(let requestId, let targetId) = try roundTrip(.tabOpened(requestId: "r1", targetId: "t1")) else {
            XCTFail("expected tabOpened")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(targetId, "t1")
    }

    func testTabOpenErrorRoundTrip() throws {
        guard case .tabOpenError(let requestId, let error) = try roundTrip(.tabOpenError(requestId: "r1", error: "nope")) else {
            XCTFail("expected tabOpenError")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(error, "nope")
    }

    func testTabTeleportRequestRoundTrip() throws {
        guard case .tabTeleportRequest(let requestId, let targetId) = try roundTrip(.tabTeleportRequest(requestId: "r1", targetId: "t1")) else {
            XCTFail("expected tabTeleportRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(targetId, "t1")
    }

    // MARK: - fs / exec

    func testFsRequestRoundTrip() throws {
        guard
            case .fsRequest(let requestId, let targetRuntimeId, let request) =
                try roundTrip(.fsRequest(requestId: "r1", targetRuntimeId: "leader", request: .stat(path: "/a")))
        else {
            XCTFail("expected fsRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(targetRuntimeId, "leader")
        XCTAssertEqual(request, .stat(path: "/a"))
    }

    func testFsResponseRoundTrip() throws {
        guard
            case .fsResponse(let requestId, let response) =
                try roundTrip(.fsResponse(requestId: "r1", response: .failure("ENOENT", code: "ENOENT")))
        else {
            XCTFail("expected fsResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(response, .failure("ENOENT", code: "ENOENT"))
    }

    func testExecRequestRoundTrip() throws {
        guard
            case .execRequest(let requestId, let command, let cwd, let env, let stdin) =
                try roundTrip(.execRequest(requestId: "r1", command: "echo hi", cwd: nil, env: nil, stdin: nil))
        else {
            XCTFail("expected execRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(command, "echo hi")
        XCTAssertNil(cwd)
        XCTAssertNil(env)
        XCTAssertNil(stdin)
    }

    func testExecChunkRoundTrip() throws {
        guard case .execChunk(let requestId, let stream, let data) = try roundTrip(.execChunk(requestId: "r1", stream: "stderr", data: "oops")) else {
            XCTFail("expected execChunk")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(stream, "stderr")
        XCTAssertEqual(data, "oops")
    }

    func testExecResponseRoundTrip() throws {
        guard
            case .execResponse(let requestId, let exitCode, let signal, let error) =
                try roundTrip(.execResponse(requestId: "r1", exitCode: 137, signal: "SIGKILL", error: "killed"))
        else {
            XCTFail("expected execResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(exitCode, 137)
        XCTAssertEqual(signal, "SIGKILL")
        XCTAssertEqual(error, "killed")
    }

    func testExecSignalRoundTrip() throws {
        guard case .execSignal(let requestId, let signal) = try roundTrip(.execSignal(requestId: "r1", signal: "SIGINT")) else {
            XCTFail("expected execSignal")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(signal, "SIGINT")
    }

    // MARK: - lick / hello / keepalive

    func testLickRoundTrip() throws {
        let body = try WireCodec.anyCodable(#"{"url":"https://x"}"#)
        let event = LickEvent(type: .navigate, timestamp: "2026-08-08T00:00:00.000Z", body: body, navigateUrl: "https://x")
        guard case .lick(let decoded) = try roundTrip(.lick(event: event)) else {
            XCTFail("expected lick")
            return
        }
        XCTAssertEqual(decoded, event)
    }

    func testHelloRoundTrip() throws {
        guard
            case .hello(let version, let runtime, let capabilities, let motd) =
                try roundTrip(.hello(protocolVersion: 6, runtime: "slicc-ios", capabilities: trayFollowerCapabilities, motd: nil))
        else {
            XCTFail("expected hello")
            return
        }
        XCTAssertEqual(version, 6)
        XCTAssertEqual(runtime, "slicc-ios")
        XCTAssertEqual(capabilities, trayFollowerCapabilities)
        XCTAssertNil(motd)
    }

    func testPingPongRoundTrip() throws {
        guard case .ping = try roundTrip(.ping) else {
            XCTFail("expected ping")
            return
        }
        guard case .pong = try roundTrip(.pong) else {
            XCTFail("expected pong")
            return
        }
    }

    // MARK: - unknown type throws

    func testUnknownTypeThrows() {
        XCTAssertThrowsError(try WireCodec.decode(FollowerToLeaderMessage.self, from: #"{"type":"not.a.real.type"}"#)) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }
}
