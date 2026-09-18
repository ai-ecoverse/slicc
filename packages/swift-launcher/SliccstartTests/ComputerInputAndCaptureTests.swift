import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import XCTest

@testable import Sliccstart

final class ComputerKeysymsTests: XCTestCase {
    func testNamedKeysCoverTheTable() {
        let expected: [String: CGKeyCode] = [
            "return": 0x24, "enter": 0x24, "kp_enter": 0x4C,
            "tab": 0x30, "space": 0x31,
            "backspace": 0x33, "delete": 0x75, "del": 0x75,
            "escape": 0x35, "esc": 0x35,
            "command": 0x37, "shift": 0x38, "capslock": 0x39, "caps_lock": 0x39,
            "option": 0x3A, "alt": 0x3A, "control": 0x3B, "ctrl": 0x3B,
            "home": 0x73, "end": 0x77, "pageup": 0x74, "page_up": 0x74, "prior": 0x74,
            "pagedown": 0x79, "page_down": 0x79, "next": 0x79,
            "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
            "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60,
            "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D,
            "f11": 0x67, "f12": 0x6F, "f13": 0x69, "f14": 0x6B, "f15": 0x71,
            "f16": 0x6A, "f17": 0x40, "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
            "grave": 0x32, "minus": 0x1B, "equal": 0x18,
            "leftbracket": 0x21, "rightbracket": 0x1E, "backslash": 0x2A,
            "semicolon": 0x29, "quote": 0x27, "comma": 0x2B, "period": 0x2F, "slash": 0x2C,
        ]
        for (name, code) in expected {
            XCTAssertEqual(ComputerKeysyms.parse(name)?.keyCode, code, name)
            let titled = name.prefix(1).uppercased() + name.dropFirst()
            XCTAssertEqual(ComputerKeysyms.parse(String(titled))?.keyCode, code, String(titled))
        }
    }

    func testLettersAndDigits() {
        XCTAssertEqual(ComputerKeysyms.parse("a")?.keyCode, 0x00)
        XCTAssertEqual(ComputerKeysyms.parse("m")?.keyCode, 0x2E)
        XCTAssertEqual(ComputerKeysyms.parse("0")?.keyCode, 0x1D)
        XCTAssertEqual(ComputerKeysyms.parse("5")?.keyCode, 0x17)
        XCTAssertEqual(ComputerKeysyms.parse(";")?.unicode, ";")
    }

    func testModifierAliases() {
        let chords: [(String, (ComputerKeyPress) -> Bool)] = [
            ("shift+a", { $0.shift && $0.keyCode == 0x00 }),
            ("ctrl+c", { $0.ctrl && $0.keyCode == 0x08 }),
            ("control+c", { $0.ctrl }),
            ("alt+tab", { $0.alt && $0.keyCode == 0x30 }),
            ("option+tab", { $0.alt }),
            ("meta+space", { $0.meta && $0.keyCode == 0x31 }),
            ("super+space", { $0.meta }),
            ("win+space", { $0.meta }),
            ("cmd+space", { $0.meta }),
            ("command+space", { $0.meta }),
            ("ctrl-alt-Delete", { $0.ctrl && $0.alt && $0.keyCode == 0x75 }),
        ]
        for (chord, check) in chords {
            let press = ComputerKeysyms.parse(chord)
            XCTAssertNotNil(press, chord)
            XCTAssertTrue(press.map(check) ?? false, chord)
        }
    }

    func testUppercaseNativePassthrough() {
        XCTAssertTrue(ComputerKeysyms.isNativeToken("KEYCODE_BACK"))
        XCTAssertTrue(ComputerKeysyms.isNativeToken("KEYCODE_HOME"))
        XCTAssertFalse(ComputerKeysyms.isNativeToken("A"))
        XCTAssertFalse(ComputerKeysyms.isNativeToken("keycode_back"))
        XCTAssertFalse(ComputerKeysyms.isNativeToken("Return"))
        let press = ComputerKeysyms.parse("KEYCODE_BACK")
        XCTAssertEqual(press?.unicode, "KEYCODE_BACK")
        XCTAssertNil(press?.keyCode)
        let chord = ComputerKeysyms.parse("ctrl+KEYCODE_ENTER")
        XCTAssertEqual(chord?.unicode, "KEYCODE_ENTER")
        XCTAssertEqual(chord?.ctrl, true)
    }

    func testUnknownTokenIsNil() {
        XCTAssertNil(ComputerKeysyms.parse("not-a-key"))
        XCTAssertNil(ComputerKeysyms.parse(""))
        XCTAssertNil(ComputerKeysyms.parse("+"))
        XCTAssertNil(ComputerKeysyms.parse("foo+a"))
    }
}

final class ComputerInputInjectorTests: XCTestCase {
    private func injector(
        encoded: CGSize = CGSize(width: 400, height: 200),
        native: CGSize = CGSize(width: 800, height: 400),
        delay: @escaping (Double) async -> Void = { _ in }
    ) -> (ComputerInputInjector, RecordingEventSink) {
        let sink = RecordingEventSink()
        return (
            ComputerInputInjector(
                sink: sink, encodedSize: encoded, nativeSize: native, delay: delay),
            sink
        )
    }

    func testClickScalesFromEncodedToNative() async {
        var (injector, sink) = injector()
        await injector.apply([.click(button: 1, count: 1, holdMs: nil, x: 100, y: 50)])
        XCTAssertEqual(
            sink.actions,
            [
                .mouseButton(.left, down: true, at: CGPoint(x: 200, y: 100)),
                .mouseButton(.left, down: false, at: CGPoint(x: 200, y: 100)),
            ])
    }

    func testNativePixelPathDoesNotRescaleWhenSizesMatch() async {
        var (injector, sink) = injector(
            encoded: CGSize(width: 1920, height: 1080),
            native: CGSize(width: 1920, height: 1080))
        await injector.apply([.mousemove(x: 1200, y: 400, relative: false)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: 1200, y: 400))])
    }

    func testZeroEncodedSizeFallsBackToIdentityScale() {
        let point = ComputerInputScaler.nativePoint(
            x: 10, y: 20, encoded: .zero, native: CGSize(width: 800, height: 400))
        XCTAssertEqual(point, CGPoint(x: 10, y: 20))
    }

    func testMoveButtonClickDragScrollKeyTextWait() async {
        var slept: [Double] = []
        var (injector, sink) = injector(delay: { slept.append($0) })
        await injector.apply([
            .mousemove(x: 10, y: 5, relative: false),
            .mousemove(x: 2, y: 3, relative: true),
            .button(button: 1, down: true, x: 20, y: 10),
            .button(button: 3, down: false, x: nil, y: nil),
            .button(button: 2, down: true, x: 1, y: 1),
            .click(button: 1, count: 0, holdMs: nil, x: 4, y: 2),
            .click(button: 1, count: 2, holdMs: 25, x: 8, y: 4),
            .scroll(dx: 1.6, dy: -2.4, x: 0, y: 0),
            .drag(x1: 1, y1: 2, x2: 3, y2: 4),
            .key(keysym: "Return", down: nil),
            .key(keysym: "a", down: true),
            .key(keysym: "a", down: false),
            .key(keysym: "ctrl+shift+alt+cmd+c", down: true),
            .key(keysym: "KEYCODE_BACK", down: false),
            .key(keysym: "not-a-key", down: nil),
            .text(text: "hi"),
            .wait(ms: 40),
        ])
        XCTAssertEqual(slept, [25, 25, 40])
        XCTAssertEqual(sink.actions[0], .mouseMove(CGPoint(x: 20, y: 10)))
        XCTAssertEqual(sink.actions[1], .mouseMove(CGPoint(x: 22, y: 13)))
        XCTAssertEqual(sink.actions[2], .mouseButton(.left, down: true, at: CGPoint(x: 40, y: 20)))
        XCTAssertEqual(sink.actions[3], .mouseButton(.right, down: false, at: CGPoint(x: 40, y: 20)))
        XCTAssertEqual(sink.actions[4], .mouseButton(.center, down: true, at: CGPoint(x: 2, y: 2)))
        XCTAssertEqual(sink.actions[5], .mouseButton(.left, down: true, at: CGPoint(x: 8, y: 4)))
        XCTAssertEqual(sink.actions[6], .mouseButton(.left, down: false, at: CGPoint(x: 8, y: 4)))
        XCTAssertEqual(sink.actions[7], .mouseButton(.left, down: true, at: CGPoint(x: 16, y: 8)))
        XCTAssertEqual(sink.actions[8], .wait(milliseconds: 25))
        XCTAssertEqual(sink.actions[9], .mouseButton(.left, down: false, at: CGPoint(x: 16, y: 8)))
        XCTAssertEqual(sink.actions[10], .mouseButton(.left, down: true, at: CGPoint(x: 16, y: 8)))
        XCTAssertEqual(sink.actions[11], .wait(milliseconds: 25))
        XCTAssertEqual(sink.actions[12], .mouseButton(.left, down: false, at: CGPoint(x: 16, y: 8)))
        XCTAssertEqual(
            sink.actions[13], .scroll(dx: 2, dy: -2, at: CGPoint(x: 0, y: 0)))
        XCTAssertEqual(sink.actions[14], .mouseMove(CGPoint(x: 2, y: 4)))
        XCTAssertEqual(sink.actions[15], .mouseButton(.left, down: true, at: CGPoint(x: 2, y: 4)))
        XCTAssertEqual(sink.actions[16], .mouseMove(CGPoint(x: 6, y: 8)))
        XCTAssertEqual(sink.actions[17], .mouseButton(.left, down: false, at: CGPoint(x: 6, y: 8)))
        guard case .key(let returnDown, true, _) = sink.actions[18],
            case .key(let returnUp, false, _) = sink.actions[19]
        else {
            return XCTFail("expected Return down/up")
        }
        XCTAssertEqual(returnDown, 0x24)
        XCTAssertEqual(returnUp, 0x24)
        guard case .key(let aDown, true, let aDownFlags) = sink.actions[20],
            case .key(let aUp, false, _) = sink.actions[21]
        else {
            return XCTFail("expected a down/up")
        }
        XCTAssertEqual(aDown, 0x00)
        XCTAssertEqual(aUp, 0x00)
        XCTAssertFalse(aDownFlags.contains(.maskShift))
        guard case .key(_, true, let chordFlags) = sink.actions[22] else {
            return XCTFail("expected chord")
        }
        XCTAssertTrue(chordFlags.contains(.maskControl))
        XCTAssertTrue(chordFlags.contains(.maskShift))
        XCTAssertTrue(chordFlags.contains(.maskAlternate))
        XCTAssertTrue(chordFlags.contains(.maskCommand))
        XCTAssertEqual(sink.actions[23], .unicode("KEYCODE_BACK", flags: []))
        XCTAssertEqual(sink.actions[24], .unicode("hi", flags: []))
        XCTAssertEqual(sink.actions[25], .wait(milliseconds: 40))
        XCTAssertEqual(sink.actions.count, 26)
    }

    func testDelayZeroReturnsImmediately() async {
        await ComputerInputDelay.sleep(0)
        await ComputerInputDelay.sleep(-1)
    }
}

final class ComputerCaptureLayoutTests: XCTestCase {
    func testClampFps() {
        XCTAssertEqual(ComputerCaptureLayout.clampFps(0), 1)
        XCTAssertEqual(ComputerCaptureLayout.clampFps(2), 2)
        XCTAssertEqual(ComputerCaptureLayout.clampFps(60), 15)
    }

    func testOutputSizeHonoursMaxWidthAndLeavesNativeAlone() {
        XCTAssertEqual(ComputerCaptureLayout.outputSize(nativeWidth: 1600, nativeHeight: 800, maxWidth: 400).width, 400)
        XCTAssertEqual(ComputerCaptureLayout.outputSize(nativeWidth: 1600, nativeHeight: 800, maxWidth: 400).height, 200)
        XCTAssertEqual(ComputerCaptureLayout.outputSize(nativeWidth: 100, nativeHeight: 1, maxWidth: 50).height, 1)
        let native = ComputerCaptureLayout.outputSize(nativeWidth: 800, nativeHeight: 600, maxWidth: nil)
        XCTAssertEqual(native.width, 800)
        XCTAssertEqual(native.height, 600)
        let oversized = ComputerCaptureLayout.outputSize(nativeWidth: 100, nativeHeight: 50, maxWidth: 400)
        XCTAssertEqual(oversized.width, 100)
        let zero = ComputerCaptureLayout.outputSize(nativeWidth: 100, nativeHeight: 50, maxWidth: 0)
        XCTAssertEqual(zero.width, 100)
    }

    func testStreamConfigurationAppliesLayout() {
        let config = ComputerCaptureLayout.streamConfiguration(
            nativeWidth: 1920, nativeHeight: 1080, fps: 30, maxWidth: 480)
        XCTAssertEqual(config.width, 480)
        XCTAssertEqual(config.height, 270)
        XCTAssertEqual(config.pixelFormat, kCVPixelFormatType_32BGRA)
        XCTAssertTrue(config.showsCursor)
        XCTAssertFalse(config.capturesAudio)
        XCTAssertEqual(config.minimumFrameInterval, CMTime(value: 1, timescale: 15))
    }

    func testFailureMapping() {
        XCTAssertEqual(
            ComputerCaptureFailure.message(for: ComputerPermissionError.screenRecording),
            ComputerPermissionError.screenRecordingMessage)
        XCTAssertEqual(
            ComputerCaptureFailure.message(for: ComputerPermissionError.accessibility),
            ComputerPermissionError.accessibilityMessage)
        XCTAssertEqual(
            ComputerCaptureFailure.message(for: ComputerCaptureError.noDisplay),
            "no display available for ScreenCaptureKit")
        XCTAssertEqual(
            ComputerCaptureFailure.message(for: ComputerCaptureError.encodeFailed),
            "failed to encode a JPEG frame")
        XCTAssertEqual(ComputerCaptureFailure.message(for: StubCaptureError.boom), "boom")
    }
}

private enum StubCaptureError: Error, CustomStringConvertible {
    case boom
    var description: String { "boom" }
}

final class ComputerPermissionsTests: XCTestCase {
    func testErrorStringsNameSystemSettings() {
        XCTAssertEqual(ComputerPermissionKind.screenRecording, .screenRecording)
        XCTAssertEqual(ComputerPermissionKind.accessibility, .accessibility)
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
            requestAccessibility: {
                requested.value = true
                return true
            }
        )
        try ComputerPermissions(probe: probe).ensureScreenRecording()
        try ComputerPermissions(probe: probe).ensureAccessibility()
        XCTAssertFalse(requested.value)
    }

    func testEnsurePromptsThenSucceeds() throws {
        let probe = ComputerPermissionProbe(
            screenRecordingGranted: { false },
            requestScreenRecording: { true },
            accessibilityGranted: { false },
            requestAccessibility: { true }
        )
        try ComputerPermissions(probe: probe).ensureScreenRecording()
        try ComputerPermissions(probe: probe).ensureAccessibility()
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

final class ComputerFrameEncoderTests: XCTestCase {
    func testScaleHonoursMaxWidth() {
        let image = ComputerTestImages.solid(width: 800, height: 400)
        let scaled = ComputerFrameEncoder.scale(image, maxWidth: 200)
        XCTAssertEqual(scaled?.width, 200)
        XCTAssertEqual(scaled?.height, 100)
        XCTAssertEqual(ComputerFrameEncoder.scale(image, maxWidth: nil)?.width, 800)
        XCTAssertEqual(ComputerFrameEncoder.scale(image, maxWidth: 0)?.width, 800)
        XCTAssertEqual(ComputerFrameEncoder.scale(image, maxWidth: 900)?.width, 800)
    }

    func testJpegRoundTripReportsNativeSize() {
        let image = ComputerTestImages.solid(width: 80, height: 40)
        let encoded = ComputerFrameEncoder.jpeg(from: image, maxWidth: 40)
        XCTAssertEqual(encoded?.width, 40)
        XCTAssertEqual(encoded?.height, 20)
        XCTAssertEqual(encoded?.nativeWidth, 80)
        XCTAssertEqual(encoded?.nativeHeight, 40)
        XCTAssertGreaterThan(encoded?.data.count ?? 0, 32)
        XCTAssertNotNil(ComputerFrameEncoder.jpeg(from: image, maxWidth: nil))
    }
}
