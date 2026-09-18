import CoreGraphics
import Foundation
import SliccTrayFollower
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
        await settle()
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
    }

    func testGrantedInputScalesClicksToNative() async throws {
        let sink = RecordingEventSink()
        let capturer = StubCapturer(
            image: ComputerTestImages.solid(width: 400, height: 200),
            native: CGSize(width: 800, height: 400))
        let (follower, _, _) = makeFollower(capturer: capturer, sink: sink)
        follower.connector(connectorStandIn(), didConnect: { _ in true })
        await settle()
        follower.route(
            try encode(
                .computerNativeCapture(requestId: "cap", fps: 1, maxWidth: 400, watch: false)))
        await settle()
        follower.route(
            try encode(
                .computerNativeInput(
                    requestId: "in-2",
                    events: [.click(button: 1, count: 1, holdMs: nil, x: 100, y: 50)])))
        await settle()

        XCTAssertEqual(
            sink.actions,
            [
                .mouseButton(.left, down: true, at: CGPoint(x: 200, y: 100)),
                .mouseButton(.left, down: false, at: CGPoint(x: 200, y: 100)),
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
        await settle()
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

    private func settle() async {
        await Task.yield()
        await Task.yield()
    }
}

final class ComputerPermissionsTests: XCTestCase {
    func testErrorStringsNameSystemSettings() {
        XCTAssertTrue(
            ComputerPermissionError.screenRecording.message.contains("System Settings"))
        XCTAssertTrue(
            ComputerPermissionError.screenRecording.message.contains("Screen Recording"))
        XCTAssertTrue(
            ComputerPermissionError.accessibility.message.contains("System Settings"))
        XCTAssertTrue(
            ComputerPermissionError.accessibility.message.contains("Accessibility"))
    }

    func testEnsureSkipsThePromptWhenAlreadyGranted() throws {
        final class Flag: @unchecked Sendable { var value = false }
        let requested = Flag()
        let probe = ComputerPermissionProbe(
            screenRecordingGranted: { true },
            requestScreenRecording: {
                requested.value = true
                return true
            },
            accessibilityGranted: { true },
            requestAccessibility: { true }
        )
        try ComputerPermissions(probe: probe).ensureScreenRecording()
        XCTAssertFalse(requested.value)
    }

    func testEnsurePromptsThenFailsClosed() {
        let permissions = ComputerPermissions(probe: .alwaysDenied)
        XCTAssertThrowsError(try permissions.ensureScreenRecording()) { error in
            XCTAssertEqual(error as? ComputerPermissionError, .screenRecording)
        }
        XCTAssertThrowsError(try permissions.ensureAccessibility()) { error in
            XCTAssertEqual(error as? ComputerPermissionError, .accessibility)
        }
    }
}

final class ComputerKeysymsTests: XCTestCase {
    func testNamedKeys() {
        XCTAssertEqual(ComputerKeysyms.parse("Return")?.keyCode, 0x24)
        XCTAssertEqual(ComputerKeysyms.parse("Escape")?.keyCode, 0x35)
        XCTAssertEqual(ComputerKeysyms.parse("Left")?.keyCode, 0x7B)
        XCTAssertEqual(ComputerKeysyms.parse("F5")?.keyCode, 0x60)
    }

    func testChordsSetModifierFlags() {
        let press = ComputerKeysyms.parse("ctrl+alt+Delete")
        XCTAssertEqual(press?.keyCode, 0x75)
        XCTAssertEqual(press?.ctrl, true)
        XCTAssertEqual(press?.alt, true)
        XCTAssertEqual(press?.shift, false)
    }

    func testUnknownTokenIsNil() {
        XCTAssertNil(ComputerKeysyms.parse("not-a-key"))
        XCTAssertNil(ComputerKeysyms.parse(""))
    }
}

final class ComputerFrameEncoderTests: XCTestCase {
    func testScaleHonoursMaxWidth() {
        let image = ComputerTestImages.solid(width: 800, height: 400)
        let scaled = ComputerFrameEncoder.scale(image, maxWidth: 200)
        XCTAssertEqual(scaled?.width, 200)
        XCTAssertEqual(scaled?.height, 100)
    }

    func testJpegRoundTripReportsNativeSize() {
        let image = ComputerTestImages.solid(width: 80, height: 40)
        let encoded = ComputerFrameEncoder.jpeg(from: image, maxWidth: 40)
        XCTAssertEqual(encoded?.width, 40)
        XCTAssertEqual(encoded?.height, 20)
        XCTAssertEqual(encoded?.nativeWidth, 80)
        XCTAssertEqual(encoded?.nativeHeight, 40)
        XCTAssertGreaterThan(encoded?.data.count ?? 0, 32)
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

final class ComputerInputInjectorTests: XCTestCase {
    func testClickScalesFromEncodedToNative() {
        let sink = RecordingSink()
        var injector = ComputerInputInjector(
            sink: sink,
            encodedSize: CGSize(width: 400, height: 200),
            nativeSize: CGSize(width: 800, height: 400))
        injector.apply([.click(button: 1, count: 1, holdMs: nil, x: 100, y: 50)])
        XCTAssertEqual(
            sink.actions,
            [
                .mouseButton(.left, down: true, at: CGPoint(x: 200, y: 100)),
                .mouseButton(.left, down: false, at: CGPoint(x: 200, y: 100)),
            ])
    }

    func testKeyChordPostsDownAndUp() {
        let sink = RecordingSink()
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: CGSize(width: 1, height: 1),
            nativeSize: CGSize(width: 1, height: 1))
        injector.apply([.key(keysym: "Return", down: nil)])
        XCTAssertEqual(sink.actions.count, 2)
        guard case .key(let downCode, true, _) = sink.actions[0],
            case .key(let upCode, false, _) = sink.actions[1]
        else {
            return XCTFail("expected key down/up")
        }
        XCTAssertEqual(downCode, 0x24)
        XCTAssertEqual(upCode, 0x24)
    }

    func testRelativeMoveAccumulates() {
        let sink = RecordingSink()
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: CGSize(width: 1, height: 1),
            nativeSize: CGSize(width: 1, height: 1))
        injector.apply([
            .mousemove(x: 10, y: 5, relative: false),
            .mousemove(x: 2, y: 3, relative: true),
        ])
        XCTAssertEqual(sink.actions.last, .mouseMove(CGPoint(x: 12, y: 8)))
    }
}

private final class RecordingSink: ComputerEventSink {
    var actions: [ComputerCGAction] = []
    func post(_ action: ComputerCGAction) { actions.append(action) }
}
