import CoreGraphics
import Foundation
import SliccTrayFollower
import WebRTC
import XCTest

@testable import Sliccstart

@MainActor
final class ComputerTrayFollowerTests: XCTestCase {
    private func connectorStandIn() -> TrayFollowerConnector {
        TrayFollowerConnector(joinUrl: URL(string: "https://tray.test/join/x")!)
    }

    private func encode(_ message: LeaderToFollowerMessage) throws -> Data {
        try JSONEncoder().encode(message)
    }

    private func makeFollower(
        capturer: StubCapturer? = nil,
        permissions: ComputerPermissions = ComputerPermissions(probe: .alwaysGranted),
        sink: RecordingEventSink? = nil
    ) -> (ComputerTrayFollower, StubCapturer, RecordingEventSink) {
        let capturer = capturer ?? StubCapturer()
        let sink = sink ?? RecordingEventSink()
        let follower = ComputerTrayFollower(
            makeConnector: { _ in RecordingConnector() },
            makeCapturer: { capturer },
            permissions: permissions,
            eventSink: sink)
        return (follower, capturer, sink)
    }

    private func connect(_ follower: ComputerTrayFollower) throws -> [Data] {
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        let hello = expectation(description: "hello")
        Task { @MainActor in hello.fulfill() }
        wait(for: [hello], timeout: 2)
        return sent
    }

    func testOpeningTheChannelAdvertisesComputerCapability() throws {
        let (follower, _, _) = makeFollower()
        let sent = try connect(follower)
        XCTAssertEqual(sent.count, 1)
        let decoded = try XCTUnwrap(
            try? JSONSerialization.jsonObject(with: XCTUnwrap(sent.first)) as? [String: Any]
        )
        XCTAssertEqual(decoded["type"] as? String, "hello")
        XCTAssertEqual(decoded["runtime"] as? String, "sliccstart-computer")
        let caps = decoded["capabilities"] as? [String: Any]
        XCTAssertEqual(caps?["computer"] as? Bool, true)
        XCTAssertEqual(caps?["exec"] as? Bool, false)
        XCTAssertEqual(decoded["protocolVersion"] as? Int, traySyncProtocolVersion)
    }

    func testCaptureSendsAJpegNativeFrameHonouringMaxWidth() async throws {
        let capturer = StubCapturer(
            image: ComputerTestImages.solid(width: 800, height: 400),
            native: CGSize(width: 1600, height: 800))
        let (follower, _, _) = makeFollower(capturer: capturer)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()

        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap-1", fps: 2, maxWidth: 400, watch: false)))
        await settle()

        XCTAssertEqual(capturer.started, 1)
        XCTAssertEqual(capturer.lastFps, 2)
        XCTAssertEqual(capturer.lastMaxWidth, 400)
        XCTAssertEqual(capturer.lastWatch, false)

        let frames = sent.compactMap { data -> [String: Any]? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.frame"
            else { return nil }
            return obj
        }
        XCTAssertEqual(frames.count, 1)
        let frame = try XCTUnwrap(frames.first)
        XCTAssertEqual(frame["requestId"] as? String, "cap-1")
        XCTAssertEqual(frame["mime"] as? String, "image/jpeg")
        XCTAssertEqual(frame["width"] as? Double, 400)
        XCTAssertEqual(frame["height"] as? Double, 200)
        XCTAssertEqual(frame["nativeWidth"] as? Double, 1600)
        XCTAssertEqual(frame["nativeHeight"] as? Double, 800)
        XCTAssertNotNil(frame["data"] as? String)
    }

    func testScreenRecordingDenialNamesSystemSettings() async throws {
        let (follower, capturer, _) = makeFollower(
            permissions: ComputerPermissions(probe: .alwaysDenied))
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap-denied", fps: nil, maxWidth: nil, watch: nil)))
        await settle()

        XCTAssertEqual(capturer.started, 0)
        let errors = sent.compactMap { data -> String? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.error"
            else { return nil }
            return obj["error"] as? String
        }
        XCTAssertEqual(errors, [ComputerPermissionError.screenRecordingMessage])
        XCTAssertTrue(errors[0].contains("System Settings"))
    }

    func testInputDenialNamesAccessibilitySettings() async throws {
        let sink = RecordingEventSink()
        let (follower, _, _) = makeFollower(
            permissions: ComputerPermissions(probe: .alwaysDenied), sink: sink)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-1",
                    events: [.click(button: 1, count: 1, holdMs: nil, x: 10, y: 20)])))
        await follower._testing_settle()
        XCTAssertTrue(sink.actions.isEmpty)
        let results = sent.compactMap { data -> (String, String?)? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.input.result",
                let requestId = obj["requestId"] as? String
            else { return nil }
            return (requestId, obj["error"] as? String)
        }
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].0, "in-1")
        XCTAssertEqual(results[0].1, ComputerPermissionError.accessibilityMessage)
        let errors = sent.compactMap { data -> String? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.error"
            else { return nil }
            return obj["error"] as? String
        }
        XCTAssertEqual(errors, [ComputerPermissionError.accessibilityMessage])
        XCTAssertTrue(
            ComputerPermissionError.accessibilityMessage.contains("System Settings"))
    }

    func testUnknownKeysymFailsTheAckAndPostsNothing() async throws {
        let sink = RecordingEventSink()
        let (follower, _, _) = makeFollower(sink: sink)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-bad",
                    events: [
                        .click(button: 1, count: 1, holdMs: nil, x: 10, y: 20),
                        .key(keysym: "Foo", down: nil),
                    ])))
        await follower._testing_settle()
        XCTAssertTrue(sink.actions.isEmpty)
        let results = sent.compactMap { data -> (String, String?)? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.input.result",
                let requestId = obj["requestId"] as? String
            else { return nil }
            return (requestId, obj["error"] as? String)
        }
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].0, "in-bad")
        XCTAssertEqual(results[0].1, "unknown keysym 'Foo' for macOS")
        let errors = sent.compactMap { data -> String? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.error"
            else { return nil }
            return obj["error"] as? String
        }
        XCTAssertEqual(errors, ["unknown keysym 'Foo' for macOS"])
    }

    func testGrantedInputUsesNativeCoordinatesWithoutRescaling() async throws {
        let sink = RecordingEventSink()
        let capturer = StubCapturer(
            image: ComputerTestImages.solid(width: 480, height: 270),
            native: CGSize(width: 1920, height: 1080))
        let (follower, _, _) = makeFollower(capturer: capturer, sink: sink)
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await follower._testing_settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap", fps: 1, maxWidth: 480, watch: false)))
        await follower._testing_settle()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-2",
                    events: [.click(button: 1, count: 1, holdMs: nil, x: 1200, y: 400)])))
        await follower._testing_settle()

        XCTAssertEqual(
            sink.actions,
            [
                .mouseButton(.left, down: true, at: CGPoint(x: 1200, y: 400)),
                .mouseButton(.left, down: false, at: CGPoint(x: 1200, y: 400)),
            ])
    }

    func testGrantedInputAcknowledgesResult() async throws {
        let sink = RecordingEventSink()
        let capturer = StubCapturer(
            image: ComputerTestImages.solid(width: 400, height: 200),
            native: CGSize(width: 800, height: 400))
        let (follower, _, _) = makeFollower(capturer: capturer, sink: sink)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap", fps: 1, maxWidth: 400, watch: false)))
        await settle()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-ok",
                    events: [.click(button: 1, count: 1, holdMs: nil, x: 10, y: 20)])))
        await follower._testing_settle()
        let results = sent.compactMap { data -> (String, String?)? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.input.result",
                let requestId = obj["requestId"] as? String
            else { return nil }
            return (requestId, obj["error"] as? String)
        }
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].0, "in-ok")
        XCTAssertNil(results[0].1)
    }

    func testUnwatchStopsTheCapturer() async throws {
        let capturer = StubCapturer()
        let (follower, _, _) = makeFollower(capturer: capturer)
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap", fps: 2, maxWidth: 64, watch: true)))
        await settle()
        XCTAssertEqual(capturer.started, 1)
        follower.route(try encode(.computerNativeUnwatch(requestId: "cap")))
        await settle()
        XCTAssertGreaterThanOrEqual(capturer.stopped, 1)
    }

    func testAlwaysConnectsWhenALeaderJoinUrlIsSet() async {
        let connector = RecordingConnector()
        let follower = ComputerTrayFollower(
            makeConnector: { _ in connector },
            makeCapturer: { StubCapturer() },
            permissions: ComputerPermissions(probe: .alwaysGranted),
            eventSink: RecordingEventSink())
        follower.leaderChanged(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        XCTAssertEqual(connector.started, 1, "computer follower must dial without a widget gate")
        follower.leaderChanged(joinUrl: nil)
        await follower._testing_settle()
        XCTAssertEqual(connector.stopped, 1)
    }

    func testGivingUpClearsTheConnectorSoRefreshCanRedial() async {
        var created = 0
        let connectors = [
            RecordingConnector(), RecordingConnector(), RecordingConnector(),
        ]
        let follower = ComputerTrayFollower(
            makeConnector: { _ in
                let connector = connectors[min(created, connectors.count - 1)]
                created += 1
                return connector
            },
            makeCapturer: { StubCapturer() },
            permissions: ComputerPermissions(probe: .alwaysGranted),
            eventSink: RecordingEventSink())
        follower.leaderChanged(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        XCTAssertEqual(created, 1)
        XCTAssertEqual(connectors[0].started, 1)

        follower.connector(connectorStandIn(), didGiveUp: "reconnect exhausted")
        await settle()
        follower.refresh()
        await follower._testing_settle()
        XCTAssertEqual(created, 2, "give-up must drop the retained connector so refresh can attach")
        XCTAssertEqual(connectors[1].started, 1)
    }

    func testWaitYieldsTheMainActorSoPingIsAnsweredBeforeAck() async throws {
        let (follower, _, _) = makeFollower()
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await follower._testing_settle()
        sent.removeAll()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-wait", events: [.wait(ms: 80)])))
        await Task.yield()
        await Task.yield()
        follower.route(try encode(.ping))
        try await Task.sleep(nanoseconds: 20_000_000)
        let typesBeforeAck = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertTrue(
            typesBeforeAck.contains("pong"),
            "a wait must not Thread.sleep on MainActor and starve ping")
        XCTAssertFalse(typesBeforeAck.contains("computer.native.input.result"))
        await follower._testing_settle()
        let types = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertTrue(types.contains("computer.native.input.result"))
    }

    func testPingAnswersPong() async throws {
        let (follower, _, _) = makeFollower()
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        sent.removeAll()
        follower.route(try encode(.ping))
        await settle()
        let types = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertEqual(types, ["pong"])
    }

    func testCaptureErrorFromCapturerMapsOntoNativeError() async throws {
        let capturer = StubCapturer()
        capturer.startError = ComputerCaptureError.noDisplay
        let (follower, _, _) = makeFollower(capturer: capturer)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap-miss", fps: nil, maxWidth: nil, watch: false)))
        await follower._testing_settle()
        let errors = sent.compactMap { data -> String? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.error"
            else { return nil }
            return obj["error"] as? String
        }
        XCTAssertEqual(errors, [ComputerCaptureError.noDisplay.message])
    }

    func testGenericCaptureErrorStringifies() async throws {
        struct Boom: Error {}
        let capturer = StubCapturer()
        capturer.startError = Boom()
        let (follower, _, _) = makeFollower(capturer: capturer)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap-boom", fps: 1, maxWidth: 64, watch: false)))
        await follower._testing_settle()
        let errors = sent.compactMap { data -> String? in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["type"] as? String == "computer.native.error"
            else { return nil }
            return obj["error"] as? String
        }
        XCTAssertEqual(errors.count, 1)
        XCTAssertTrue(errors[0].contains("Boom"))
    }

    func testWatchStreamEndRecreatesTheCapturer() async throws {
        let capturer = StubCapturer()
        capturer.endsRemaining = 1
        let (follower, _, _) = makeFollower(capturer: capturer)
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "watch", fps: 2, maxWidth: 64, watch: true)))
        await follower._testing_settle()
        await settle()
        await follower._testing_settle()
        XCTAssertEqual(capturer.started, 2)
        XCTAssertEqual(capturer.lastWatch, true)
    }

    func testDisconnectStopsCaptureAndReconnectDelegateIsANoOp() async throws {
        let capturer = StubCapturer()
        let (follower, _, _) = makeFollower(capturer: capturer)
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap", fps: 2, maxWidth: 64, watch: true)))
        await settle()
        XCTAssertEqual(capturer.started, 1)
        follower.connector(connectorStandIn(), isReconnecting: 1)
        follower.connectorDidDisconnect(connectorStandIn(), reason: "peer dropped")
        await settle()
        XCTAssertGreaterThanOrEqual(capturer.stopped, 1)
        follower.connector(connectorStandIn(), didReceiveInfo: "tray", participantCount: 1)
        follower.connector(
            connectorStandIn(),
            didGenerateCandidate: RTCIceCandidate(sdp: "a", sdpMLineIndex: 0, sdpMid: "0"))
    }

    func testDidReceiveDataRoutesPing() async throws {
        let (follower, _, _) = makeFollower()
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        sent.removeAll()
        follower.connector(connectorStandIn(), didReceiveData: try encode(.ping))
        await settle()
        let types = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertEqual(types, ["pong"])
    }

    func testChunkedPingReassembles() async throws {
        let (follower, _, _) = makeFollower()
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        sent.removeAll()
        let ping = try encode(.ping)
        let frames = TrayChunkFraming.frameChunks(String(data: ping, encoding: .utf8)!)
        for frame in frames {
            follower.route(try JSONEncoder().encode(frame))
        }
        await settle()
        let types = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertEqual(types, ["pong"])
    }

    func testMalformedAndUnknownMessagesAreIgnored() async throws {
        let (follower, _, _) = makeFollower()
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(Data("not-json".utf8))
        follower.route(try JSONEncoder().encode(["type": "computers.list"]))
        follower.route(
            try encode(.computerNativeUnwatch(requestId: "none")))
    }

    func testStaleFrameAfterUnwatchIsDropped() async throws {
        let capturer = StubCapturer()
        capturer.holdFrame = true
        let (follower, _, _) = makeFollower(capturer: capturer)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "stale", fps: 1, maxWidth: 64, watch: false)))
        await follower._testing_settle()
        follower.route(try encode(.computerNativeUnwatch(requestId: "stale")))
        await settle()
        sent.removeAll()
        capturer.emitHeldFrame()
        await settle()
        let frames = sent.compactMap { data -> String? in
            (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        }
        XCTAssertFalse(frames.contains("computer.native.frame"))
    }

    func testZeroNativeSizeFallsBackToEncodedSize() async throws {
        let capturer = StubCapturer(
            image: ComputerTestImages.solid(width: 40, height: 20), native: .zero)
        let (follower, _, _) = makeFollower(capturer: capturer)
        var sent: [Data] = []
        follower.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap-zero", fps: 1, maxWidth: 40, watch: false)))
        await follower._testing_settle()
        let frame = try XCTUnwrap(
            sent.compactMap { data -> [String: Any]? in
                guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    obj["type"] as? String == "computer.native.frame"
                else { return nil }
                return obj
            }.first)
        XCTAssertEqual(frame["nativeWidth"] as? Double, 40)
        XCTAssertEqual(frame["nativeHeight"] as? Double, 20)
    }

    func testAttachFailureClearsTheConnectorSoRefreshRedials() async {
        struct AttachFailed: Error {}
        let first = RecordingConnector()
        first.startError = AttachFailed()
        let second = RecordingConnector()
        var created = 0
        let follower = ComputerTrayFollower(
            makeConnector: { _ in
                created += 1
                return created == 1 ? first : second
            },
            makeCapturer: { StubCapturer() },
            permissions: ComputerPermissions(probe: .alwaysGranted),
            eventSink: RecordingEventSink())
        follower.leaderChanged(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        XCTAssertEqual(first.started, 1)
        follower.refresh()
        await follower._testing_settle()
        XCTAssertEqual(second.started, 1)
    }

    func testSameJoinUrlIsANoOpAndNilTearsDown() async {
        let connector = RecordingConnector()
        let follower = ComputerTrayFollower(
            makeConnector: { _ in connector },
            makeCapturer: { StubCapturer() },
            permissions: ComputerPermissions(probe: .alwaysGranted),
            eventSink: RecordingEventSink())
        follower.leaderChanged(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        XCTAssertEqual(connector.started, 1)
        follower.leaderChanged(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        XCTAssertEqual(connector.started, 1)
        follower.leaderChanged(joinUrl: nil)
        await follower._testing_settle()
        XCTAssertEqual(connector.stopped, 1)
    }

    func testUnknownMessageVariantIsIgnored() async throws {
        let (follower, capturer, _) = makeFollower()
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(try encode(.computersList(computers: [])))
        XCTAssertEqual(capturer.started, 0)
    }

    private func settle() async {
        await Task.yield()
        await Task.yield()
    }
}

final class ComputerNativeFramingTests: XCTestCase {
    func testSmallPayloadIsUnchunked() throws {
        let messages = ComputerNativeFraming.messages(
            requestId: "r", seq: 1, width: 10, height: 10, nativeWidth: 20, nativeHeight: 20,
            data: "abc")
        XCTAssertEqual(messages.count, 1)
        guard
            case .computerNativeFrame(_, _, _, _, _, _, _, let data, let chunk, _, _) =
                messages[0]
        else {
            return XCTFail("expected native frame")
        }
        XCTAssertEqual(data, "abc")
        XCTAssertNil(chunk)
    }

    func testOversizePayloadSplitsAt32KiB() {
        let payload = String(repeating: "a", count: ComputerNativeFraming.chunkThreshold + 10)
        let messages = ComputerNativeFraming.messages(
            requestId: "r", seq: 3, width: 1, height: 1, nativeWidth: 1, nativeHeight: 1,
            data: payload)
        XCTAssertGreaterThan(messages.count, 1)
        guard
            case .computerNativeFrame(_, let seq, _, _, _, _, _, let data, let chunk, let index, let total) =
                messages[0]
        else {
            return XCTFail("expected native frame")
        }
        XCTAssertEqual(seq, 3)
        XCTAssertNil(data)
        XCTAssertEqual(index, 0)
        XCTAssertEqual(total, messages.count)
        XCTAssertEqual(chunk?.count, ComputerNativeFraming.chunkSize)
    }
}
