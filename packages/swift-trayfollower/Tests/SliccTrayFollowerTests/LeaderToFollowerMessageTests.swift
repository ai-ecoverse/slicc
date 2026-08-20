import Foundation
import XCTest

@testable import SliccTrayFollower

/// Round-trips of every `LeaderToFollowerMessage` variant through the custom
/// `init(from:)` / `encode(to:)` switches — the bulk of the protocol surface.
final class LeaderToFollowerMessageTests: XCTestCase {

    private func roundTrip(_ message: LeaderToFollowerMessage) throws -> LeaderToFollowerMessage {
        try WireCodec.roundTrip(message)
    }

    // MARK: - Chat / snapshot

    func testSnapshotRoundTrip() throws {
        let message = ChatMessage(id: "m1", role: .assistant, content: "hello", timestamp: 1_700)
        guard case .snapshot(let messages, let scoopJid) = try roundTrip(.snapshot(messages: [message], scoopJid: "s1")) else {
            XCTFail("expected snapshot")
            return
        }
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.id, "m1")
        XCTAssertEqual(messages.first?.content, "hello")
        XCTAssertEqual(scoopJid, "s1")
    }

    func testSnapshotToleratesMissingFields() throws {
        // Lenient decode: missing `messages`/`scoopJid` collapse to []/"".
        guard case .snapshot(let messages, let scoopJid) = try WireCodec.decode(LeaderToFollowerMessage.self, from: #"{"type":"snapshot"}"#) else {
            XCTFail("expected snapshot")
            return
        }
        XCTAssertTrue(messages.isEmpty)
        XCTAssertEqual(scoopJid, "")
    }

    func testSnapshotChunkRoundTrip() throws {
        guard
            case .snapshotChunk(let chunkData, let chunkIndex, let totalChunks, let scoopJid) =
                try roundTrip(.snapshotChunk(chunkData: "abc", chunkIndex: 1, totalChunks: 4, scoopJid: "s1"))
        else {
            XCTFail("expected snapshotChunk")
            return
        }
        XCTAssertEqual(chunkData, "abc")
        XCTAssertEqual(chunkIndex, 1)
        XCTAssertEqual(totalChunks, 4)
        XCTAssertEqual(scoopJid, "s1")
    }

    func testAgentEventRoundTrip() throws {
        guard
            case .agentEvent(let event, let scoopJid) =
                try roundTrip(.agentEvent(event: .contentDelta(messageId: "m1", text: "hi"), scoopJid: "s1"))
        else {
            XCTFail("expected agentEvent")
            return
        }
        guard case .contentDelta(let messageId, let text) = event else {
            XCTFail("expected contentDelta")
            return
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(scoopJid, "s1")
    }

    func testUserMessageEchoWithAttachments() throws {
        let attachment = MessageAttachment(id: "a1", name: "pic.png", mimeType: "image/png", size: 12, kind: .image, data: "AAAA")
        guard
            case .userMessageEcho(let text, let messageId, let scoopJid, let attachments) =
                try roundTrip(.userMessageEcho(text: "hi", messageId: "m1", scoopJid: "s1", attachments: [attachment]))
        else {
            XCTFail("expected userMessageEcho")
            return
        }
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(scoopJid, "s1")
        XCTAssertEqual(attachments, [attachment])
    }

    func testUserMessageEchoWithoutAttachments() throws {
        guard
            case .userMessageEcho(_, _, _, let attachments) =
                try roundTrip(.userMessageEcho(text: "hi", messageId: "m1", scoopJid: "s1", attachments: nil))
        else {
            XCTFail("expected userMessageEcho")
            return
        }
        XCTAssertNil(attachments)
    }

    // MARK: - Status / error

    func testStatusWithScoopJid() throws {
        guard case .status(let scoopStatus, let scoopJid) = try roundTrip(.status(scoopStatus: "thinking", scoopJid: "s1")) else {
            XCTFail("expected status")
            return
        }
        XCTAssertEqual(scoopStatus, "thinking")
        XCTAssertEqual(scoopJid, "s1")
    }

    func testStatusWithoutScoopJid() throws {
        guard case .status(let scoopStatus, let scoopJid) = try roundTrip(.status(scoopStatus: "idle", scoopJid: nil)) else {
            XCTFail("expected status")
            return
        }
        XCTAssertEqual(scoopStatus, "idle")
        XCTAssertNil(scoopJid)
    }

    func testErrorRoundTrip() throws {
        guard case .error(let error) = try roundTrip(.error(error: "boom")) else {
            XCTFail("expected error")
            return
        }
        XCTAssertEqual(error, "boom")
    }

    // MARK: - Scoops / models / sprinkles

    func testScoopsListRoundTrip() throws {
        let scoop = ScoopSummary(
            jid: "j1", name: "Cone", folder: "/", isCone: true, assistantLabel: "A",
            trigger: "manual", state: "active", fill: 42.5)
        guard case .scoopsList(let scoops, let active) = try roundTrip(.scoopsList(scoops: [scoop], activeScoopJid: "j1")) else {
            XCTFail("expected scoopsList")
            return
        }
        XCTAssertEqual(scoops, [scoop])
        XCTAssertEqual(active, "j1")
    }

    func testScoopsListToleratesMissingFields() throws {
        guard case .scoopsList(let scoops, let active) = try WireCodec.decode(LeaderToFollowerMessage.self, from: #"{"type":"scoops.list"}"#) else {
            XCTFail("expected scoopsList")
            return
        }
        XCTAssertTrue(scoops.isEmpty)
        XCTAssertEqual(active, "")
    }

    func testModelsListRoundTrip() throws {
        let entry = TrayModelCatalogEntry(providerName: "anthropic", modelId: "claude-x", modelName: "Claude", reasoning: true)
        guard case .modelsList(let models) = try roundTrip(.modelsList(models: [entry])) else {
            XCTFail("expected modelsList")
            return
        }
        XCTAssertEqual(models, [entry])
    }

    func testModelStateRoundTrip() throws {
        let state = TrayModelSelectionState(activeModelId: "claude-x", scoopJid: "j1", thinkingLevel: .high, effortOverride: "max")
        guard case .modelState(let decoded) = try roundTrip(.modelState(state: state)) else {
            XCTFail("expected modelState")
            return
        }
        XCTAssertEqual(decoded, state)
    }

    func testSprinklesListRoundTrip() throws {
        let sprinkle = SprinkleSummary(name: "n", title: "T", path: "/p", open: true, autoOpen: true, icon: "sparkle")
        guard case .sprinklesList(let sprinkles) = try roundTrip(.sprinklesList(sprinkles: [sprinkle])) else {
            XCTFail("expected sprinklesList")
            return
        }
        XCTAssertEqual(sprinkles, [sprinkle])
    }

    func testSprinkleContentRoundTrip() throws {
        guard
            case .sprinkleContent(let requestId, let name, let content, let chunkIndex, let totalChunks, let error) =
                try roundTrip(.sprinkleContent(requestId: "r1", sprinkleName: "s", content: "<html>", chunkIndex: 0, totalChunks: 3, error: nil))
        else {
            XCTFail("expected sprinkleContent")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(name, "s")
        XCTAssertEqual(content, "<html>")
        XCTAssertEqual(chunkIndex, 0)
        XCTAssertEqual(totalChunks, 3)
        XCTAssertNil(error)
    }

    func testSprinkleContentToleratesMissingContent() throws {
        guard
            case .sprinkleContent(_, _, let content, _, _, let error) =
                try WireCodec.decode(
                    LeaderToFollowerMessage.self,
                    from: #"{"type":"sprinkle.content","requestId":"r1","sprinkleName":"s","error":"gone"}"#)
        else {
            XCTFail("expected sprinkleContent")
            return
        }
        XCTAssertEqual(content, "")
        XCTAssertEqual(error, "gone")
    }

    func testSprinkleUpdateRoundTrip() throws {
        let data = try WireCodec.anyCodable(#"{"k":"v","n":3}"#)
        guard case .sprinkleUpdate(let name, let decoded) = try roundTrip(.sprinkleUpdate(sprinkleName: "s", data: data)) else {
            XCTFail("expected sprinkleUpdate")
            return
        }
        XCTAssertEqual(name, "s")
        XCTAssertEqual(try WireCodec.canonical(decoded), try WireCodec.canonical(data))
    }

    func testSprinkleReloadedRoundTrip() throws {
        guard case .sprinkleReloaded(let name) = try roundTrip(.sprinkleReloaded(sprinkleName: "s")) else {
            XCTFail("expected sprinkleReloaded")
            return
        }
        XCTAssertEqual(name, "s")
    }

    // MARK: - CDP / targets

    func testCdpRequestRoundTrip() throws {
        let params = try WireCodec.anyCodable(#"{"url":"https://example.com"}"#)
        guard
            case .cdpRequest(let requestId, let localTargetId, let method, let decodedParams, let sessionId) =
                try roundTrip(.cdpRequest(requestId: "r1", localTargetId: "t1", method: "Page.navigate", params: params, sessionId: "sess"))
        else {
            XCTFail("expected cdpRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(localTargetId, "t1")
        XCTAssertEqual(method, "Page.navigate")
        XCTAssertEqual(decodedParams, params)
        XCTAssertEqual(sessionId, "sess")
    }

    func testCdpResponseRoundTrip() throws {
        let result = try WireCodec.anyCodable(#"{"ok":true}"#)
        guard
            case .cdpResponse(let requestId, let decodedResult, let error, let chunkData, let chunkIndex, let totalChunks) =
                try roundTrip(.cdpResponse(requestId: "r1", result: result, error: nil, chunkData: "slice", chunkIndex: 0, totalChunks: 2))
        else {
            XCTFail("expected cdpResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(decodedResult, result)
        XCTAssertNil(error)
        XCTAssertEqual(chunkData, "slice")
        XCTAssertEqual(chunkIndex, 0)
        XCTAssertEqual(totalChunks, 2)
    }

    func testTargetsRegistryRoundTrip() throws {
        let target = TrayTargetEntry(
            targetId: "t1", localTargetId: "l1", runtimeId: "r1", title: "Tab", url: "https://x",
            isLocal: true, kind: "cherry",
            capabilities: CherryCapabilities(navigate: true, network: false, screenshot: true))
        guard case .targetsRegistry(let targets) = try roundTrip(.targetsRegistry(targets: [target])) else {
            XCTFail("expected targetsRegistry")
            return
        }
        XCTAssertEqual(targets, [target])
    }

    func testTabOpenRoundTrip() throws {
        guard case .tabOpen(let requestId, let url) = try roundTrip(.tabOpen(requestId: "r1", url: "https://x")) else {
            XCTFail("expected tabOpen")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(url, "https://x")
    }

    func testPreviewOpenRoundTrip() throws {
        guard case .previewOpen(let requestId, let url) = try roundTrip(.previewOpen(requestId: "r1", url: "https://x")) else {
            XCTFail("expected previewOpen")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(url, "https://x")
    }

    func testCherrySliccEventWithDetail() throws {
        let detail = try WireCodec.anyCodable(#"{"count":2}"#)
        guard
            case .cherrySliccEvent(let targetId, let name, let decoded) =
                try roundTrip(.cherrySliccEvent(targetId: "t1", name: "evt", detail: detail))
        else {
            XCTFail("expected cherrySliccEvent")
            return
        }
        XCTAssertEqual(targetId, "t1")
        XCTAssertEqual(name, "evt")
        XCTAssertEqual(decoded, detail)
    }

    func testCherrySliccEventWithoutDetail() throws {
        guard case .cherrySliccEvent(_, _, let detail) = try roundTrip(.cherrySliccEvent(targetId: "t1", name: "evt", detail: nil)) else {
            XCTFail("expected cherrySliccEvent")
            return
        }
        XCTAssertNil(detail)
    }

    // MARK: - fs / exec (remote-operation encode/decode helpers)

    func testFsRequestRoundTrip() throws {
        guard
            case .fsRequest(let requestId, let request) =
                try roundTrip(.fsRequest(requestId: "r1", request: .readFile(path: "/a", encoding: .utf8)))
        else {
            XCTFail("expected fsRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(request, .readFile(path: "/a", encoding: .utf8))
    }

    func testFsResponseRoundTrip() throws {
        guard
            case .fsResponse(let requestId, let response) =
                try roundTrip(.fsResponse(requestId: "r1", response: .success(.exists(true))))
        else {
            XCTFail("expected fsResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(response, .success(.exists(true)))
    }

    func testExecRequestRoundTrip() throws {
        guard
            case .execRequest(let requestId, let command, let cwd, let env) =
                try roundTrip(.execRequest(requestId: "r1", command: "ls -la", cwd: "/tmp", env: ["A": "B"]))
        else {
            XCTFail("expected execRequest")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(command, "ls -la")
        XCTAssertEqual(cwd, "/tmp")
        XCTAssertEqual(env, ["A": "B"])
    }

    func testExecChunkRoundTrip() throws {
        guard
            case .execChunk(let requestId, let stream, let data) =
                try roundTrip(.execChunk(requestId: "r1", stream: "stdout", data: "line"))
        else {
            XCTFail("expected execChunk")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(stream, "stdout")
        XCTAssertEqual(data, "line")
    }

    func testExecResponseRoundTrip() throws {
        guard
            case .execResponse(let requestId, let exitCode, let signal, let error) =
                try roundTrip(.execResponse(requestId: "r1", exitCode: 0, signal: nil, error: nil))
        else {
            XCTFail("expected execResponse")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(exitCode, 0)
        XCTAssertNil(signal)
        XCTAssertNil(error)
    }

    func testExecSignalRoundTrip() throws {
        guard case .execSignal(let requestId, let signal) = try roundTrip(.execSignal(requestId: "r1", signal: "SIGTERM")) else {
            XCTFail("expected execSignal")
            return
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(signal, "SIGTERM")
    }

    // MARK: - Theme / hello / keepalive / unknown

    func testThemeApplyWithJson() throws {
        guard case .themeApply(let themeJson) = try roundTrip(.themeApply(themeJson: #"{"base":"dark"}"#)) else {
            XCTFail("expected themeApply")
            return
        }
        XCTAssertEqual(themeJson, #"{"base":"dark"}"#)
    }

    func testThemeApplyWithNilResetsScheme() throws {
        guard case .themeApply(let themeJson) = try roundTrip(.themeApply(themeJson: nil)) else {
            XCTFail("expected themeApply")
            return
        }
        XCTAssertNil(themeJson)
    }

    func testHelloRoundTrip() throws {
        let capabilities = TraySyncCapabilities(exec: true, browser: true, oauthPopup: false)
        guard
            case .hello(let version, let runtime, let decodedCaps, let motd) =
                try roundTrip(.hello(protocolVersion: traySyncProtocolVersion, runtime: "slicc-ios", capabilities: capabilities, motd: "welcome"))
        else {
            XCTFail("expected hello")
            return
        }
        XCTAssertEqual(version, traySyncProtocolVersion)
        XCTAssertEqual(runtime, "slicc-ios")
        XCTAssertEqual(decodedCaps, capabilities)
        XCTAssertEqual(motd, "welcome")
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

    func testUnknownRoundTrip() throws {
        guard case .unknown(let type) = try roundTrip(.unknown(type: "future.thing")) else {
            XCTFail("expected unknown")
            return
        }
        XCTAssertEqual(type, "future.thing")
    }

    func testUnknownTypeDecodesToUnknown() throws {
        guard case .unknown(let type) = try WireCodec.decode(LeaderToFollowerMessage.self, from: #"{"type":"totally.new"}"#) else {
            XCTFail("expected unknown")
            return
        }
        XCTAssertEqual(type, "totally.new")
    }

    func testTranscriptExportVariantsDecodeToUnknown() throws {
        let types = [
            "transcript.export.pending",
            "transcript.export.denied",
            "transcript.export.start",
            "transcript.export.chunk",
            "transcript.export.complete",
            "transcript.export.error",
        ]
        for type in types {
            guard case .unknown(let decoded) = try WireCodec.decode(LeaderToFollowerMessage.self, from: #"{"type":"\#(type)"}"#) else {
                XCTFail("expected unknown for \(type)")
                return
            }
            XCTAssertEqual(decoded, type)
        }
    }

    // MARK: - Discriminators

    func testDiscriminatorsMatchWireTags() throws {
        XCTAssertEqual(try WireCodec.discriminator(LeaderToFollowerMessage.ping), "ping")
        XCTAssertEqual(try WireCodec.discriminator(LeaderToFollowerMessage.pong), "pong")
        XCTAssertEqual(
            try WireCodec.discriminator(LeaderToFollowerMessage.fsRequest(requestId: "r", request: .exists(path: "/a"))),
            "fs.request")
        XCTAssertEqual(
            try WireCodec.discriminator(LeaderToFollowerMessage.execSignal(requestId: "r", signal: "SIGINT")),
            "exec.signal")
        XCTAssertEqual(try WireCodec.discriminator(LeaderToFollowerMessage.error(error: "x")), "error")
    }
}
