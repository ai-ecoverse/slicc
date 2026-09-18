import Foundation
import XCTest

@testable import SliccTrayFollower

/// Wire types for `computers.list` / `computer.input` / `computer.native.*`.
final class ComputerProtocolTests: XCTestCase {

    private func descriptor() -> ComputerDescriptor {
        ComputerDescriptor(
            id: "ssh:desk", kind: "ssh", title: "Desk",
            size: ComputerSize(width: 1920, height: 1080),
            state: "live",
            capabilities: ComputerCapabilities(
                screenshot: true, text: false, frames: "push", keyboard: true,
                mouse: "absolute", scroll: true, exec: false, inputAllowed: true),
            pid: 42,
            softKeys: [ComputerSoftKey(label: "Home", keysym: "Home")],
            lastShot: ComputerLastShot(width: 480, height: 270, scale: 0.25, at: 1))
    }

    func testDescriptorRoundTrip() throws {
        XCTAssertEqual(try WireCodec.roundTrip(descriptor()), descriptor())
        XCTAssertEqual(descriptor().id, "ssh:desk")
    }

    func testDescriptorOptionalDefaults() {
        let row = ComputerDescriptor(
            id: "jsh:clock", kind: "jsh", title: "Clock", size: nil, state: "gone",
            capabilities: ComputerCapabilities(
                screenshot: false, text: true, frames: "none", keyboard: false,
                mouse: "none", scroll: false, exec: true, inputAllowed: false),
            pid: nil)
        XCTAssertNil(row.size)
        XCTAssertNil(row.pid)
        XCTAssertNil(row.softKeys)
        XCTAssertNil(row.lastShot)
    }

    func testEveryInputEventRoundTrips() throws {
        let events: [ComputerInputEvent] = [
            .mousemove(x: 10, y: 20, relative: nil),
            .mousemove(x: 1, y: -1, relative: true),
            .button(button: 1, down: true, x: 4, y: 5),
            .button(button: 2, down: false, x: nil, y: nil),
            .click(button: 3, count: 2, holdMs: 400, x: 8, y: 9),
            .click(button: 1, count: 1, holdMs: nil, x: nil, y: nil),
            .scroll(dx: 0, dy: -40, x: 10, y: 10),
            .scroll(dx: 1, dy: 2, x: nil, y: nil),
            .drag(x1: 10, y1: 20, x2: 200, y2: 80),
            .key(keysym: "ctrl+alt+Delete", down: nil),
            .key(keysym: "KEYCODE_BACK", down: false),
            .text(text: "ls -la\n"),
            .wait(ms: 500),
        ]
        for event in events {
            XCTAssertEqual(try WireCodec.roundTrip(event), event)
        }
    }

    func testUnknownInputEventTypeThrows() {
        XCTAssertThrowsError(
            try WireCodec.decode(ComputerInputEvent.self, from: #"{"type":"explode"}"#)
        ) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }
}
