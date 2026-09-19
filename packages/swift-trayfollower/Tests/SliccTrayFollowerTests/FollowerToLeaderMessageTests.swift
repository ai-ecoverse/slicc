import Foundation
import XCTest

@testable import SliccTrayFollower




final class FollowerToLeaderMessageTests: XCTestCase {

    private func roundTrip(_ message: FollowerToLeaderMessage) throws -> FollowerToLeaderMessage {
        try WireCodec.roundTrip(message)
    }

    

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
        
        let json = try WireCodec.jsonString(FollowerToLeaderMessage.userMessage(text: "hi", messageId: "m1", attachments: []))
        XCTAssertFalse(json.contains("attachments"))
    }

    

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
        guard case .requestSnapshot(let scoopJid, let peek) = try roundTrip(.requestSnapshot(scoopJid: "s1")) else {
            XCTFail("expected requestSnapshot")
            return
        }
        XCTAssertEqual(scoopJid, "s1")
        XCTAssertFalse(peek)

        guard case .requestSnapshot(let none, _) = try roundTrip(.requestSnapshot(scoopJid: nil)) else {
            XCTFail("expected requestSnapshot")
            return
        }
        XCTAssertNil(none)
    }

    func testPeekIsOmittedUnlessSetAndSurvivesARoundTrip() throws {
        let plain = try JSONEncoder().encode(FollowerToLeaderMessage.requestSnapshot(scoopJid: "s1"))
        let plainObject = try XCTUnwrap(try JSONSerialization.jsonObject(with: plain) as? [String: Any])
        XCTAssertNil(plainObject["peek"], "an ordinary snapshot request stays byte-identical")

        guard
            case .requestSnapshot(let scoopJid, let peek) = try roundTrip(
                .requestSnapshot(scoopJid: "s2", peek: true))
        else {
            XCTFail("expected requestSnapshot")
            return
        }
        XCTAssertEqual(scoopJid, "s2")
        XCTAssertTrue(peek)
    }

    func testScoopsSelectRoundTrip() throws {
        guard case .scoopsSelect(let scoopJid) = try roundTrip(.scoopsSelect(scoopJid: "s1")) else {
            XCTFail("expected scoopsSelect")
            return
        }
        XCTAssertEqual(scoopJid, "s1")
    }

    

    func testModelsRequestRoundTrip() throws {
        guard case .modelsRequest = try roundTrip(.modelsRequest) else {
            XCTFail("expected modelsRequest")
            return
        }
    }

    func testModelSelectRoundTrip() throws {
        guard
            case .modelSelect(let modelId, let scoopJid) = try roundTrip(
                .modelSelect(modelId: "claude-x", scoopJid: "cone_2"))
        else {
            XCTFail("expected modelSelect")
            return
        }
        XCTAssertEqual(modelId, "claude-x")
        
        
        XCTAssertEqual(scoopJid, "cone_2")
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

    

    func testLickRoundTrip() throws {
        let body = try WireCodec.anyCodable(#"{"url":"https:
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

    

    func testUnknownTypeThrows() {
        XCTAssertThrowsError(try WireCodec.decode(FollowerToLeaderMessage.self, from: #"{"type":"not.a.real.type"}"#)) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }

    

    func testComputerWatchUnwatchAndInputRoundTrip() throws {
        guard
            case .computerWatch(let id, let fps, let maxWidth) = try roundTrip(
                .computerWatch(id: "jsh:clock", fps: 2, maxWidth: 480))
        else {
            XCTFail("expected computer.watch")
            return
        }
        XCTAssertEqual(id, "jsh:clock")
        XCTAssertEqual(fps, 2)
        XCTAssertEqual(maxWidth, 480)

        guard case .computerUnwatch(let dropped) = try roundTrip(.computerUnwatch(id: "jsh:clock"))
        else {
            XCTFail("expected computer.unwatch")
            return
        }
        XCTAssertEqual(dropped, "jsh:clock")

        let events: [ComputerInputEvent] = [.text(text: "ls"), .key(keysym: "Return", down: nil)]
        guard
            case .computerInput(let target, let decoded) = try roundTrip(
                .computerInput(id: "jsh:clock", events: events))
        else {
            XCTFail("expected computer.input")
            return
        }
        XCTAssertEqual(target, "jsh:clock")
        XCTAssertEqual(decoded, events)

        guard
            case .computerInput(_, let empty) = try WireCodec.decode(
                FollowerToLeaderMessage.self, from: #"{"type":"computer.input","id":"jsh:clock"}"#)
        else {
            XCTFail("expected computer.input")
            return
        }
        XCTAssertTrue(empty.isEmpty)
    }

    func testComputerNativeFollowerMessagesRoundTrip() throws {
        guard
            case .computerNativeFrame(
                let requestId, let seq, let mime, let width, let height, let nativeWidth,
                let nativeHeight, let data, let chunkData, let chunkIndex, let totalChunks) =
                try roundTrip(
                    .computerNativeFrame(
                        requestId: "cap-1", seq: 7, mime: "image/jpeg", width: 480, height: 270,
                        nativeWidth: 1920, nativeHeight: 1080, data: "QUJD", chunkData: nil,
                        chunkIndex: nil, totalChunks: nil))
        else {
            XCTFail("expected computer.native.frame")
            return
        }
        XCTAssertEqual(requestId, "cap-1")
        XCTAssertEqual(seq, 7)
        XCTAssertEqual(mime, "image/jpeg")
        XCTAssertEqual(width, 480)
        XCTAssertEqual(height, 270)
        XCTAssertEqual(nativeWidth, 1920)
        XCTAssertEqual(nativeHeight, 1080)
        XCTAssertEqual(data, "QUJD")
        XCTAssertNil(chunkData)
        XCTAssertNil(chunkIndex)
        XCTAssertNil(totalChunks)

        guard
            case .computerNativeFrame(_, _, _, _, _, _, _, _, let slice, let index, let total) =
                try roundTrip(
                    .computerNativeFrame(
                        requestId: "cap-1", seq: 8, mime: "image/jpeg", width: 16, height: 16,
                        nativeWidth: 16, nativeHeight: 16, data: nil, chunkData: "aa",
                        chunkIndex: 0, totalChunks: 2))
        else {
            XCTFail("expected chunked computer.native.frame")
            return
        }
        XCTAssertEqual(slice, "aa")
        XCTAssertEqual(index, 0)
        XCTAssertEqual(total, 2)

        guard
            case .computerNativeError(let errId, let error) = try roundTrip(
                .computerNativeError(requestId: "cap-1", error: "Screen Recording denied"))
        else {
            XCTFail("expected computer.native.error")
            return
        }
        XCTAssertEqual(errId, "cap-1")
        XCTAssertEqual(error, "Screen Recording denied")

        guard
            case .computerNativeInputResult(let okId, let okError) = try roundTrip(
                .computerNativeInputResult(requestId: "in-ok", error: nil))
        else {
            XCTFail("expected computer.native.input.result")
            return
        }
        XCTAssertEqual(okId, "in-ok")
        XCTAssertNil(okError)

        guard
            case .computerNativeInputResult(_, let denied) = try roundTrip(
                .computerNativeInputResult(requestId: "in-no", error: "Accessibility denied"))
        else {
            XCTFail("expected computer.native.input.result")
            return
        }
        XCTAssertEqual(denied, "Accessibility denied")
    }
}
