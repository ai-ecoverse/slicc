import XCTest
import Foundation
@testable import SliccFollower

// NOTE: packages/ios-app/Package.swift does not yet declare an XCTest target,
// so this file is not compiled by `swift test` today (see packages/ios-app/CLAUDE.md
// — "Swift parity is enforced by inspection until a test target lands"). It is the
// ready-to-wire seam for when an iOS test target is added under Xcode/CI with the
// iOS SDK (the package depends on an iOS-only WebRTC binary, so `swift test` cannot
// run on a plain macOS host). The assertions here were verified out-of-band by
// compiling the Foundation-only protocol sources directly with swiftc.
final class SyncProtocolCherryTests: XCTestCase {
    func testRemoteTargetInfoDecodesCherryKindAndCapabilities() throws {
        let json = """
        {"targetId":"c","title":"Host","url":"https://host.example",
         "kind":"cherry","capabilities":{"navigate":true,"network":false,"screenshot":true}}
        """.data(using: .utf8)!
        let target = try JSONDecoder().decode(RemoteTargetInfo.self, from: json)
        XCTAssertEqual(target.kind, "cherry")
        XCTAssertEqual(target.capabilities?.network, false)
        XCTAssertEqual(target.capabilities?.navigate, true)
    }

    func testCherrySliccEventMessageDecodes() throws {
        let json = """
        {"type":"cherry.slicc_event","targetId":"c","name":"open-url","detail":{"url":"https://x"}}
        """.data(using: .utf8)!
        let msg = try JSONDecoder().decode(LeaderToFollowerMessage.self, from: json)
        guard case let .cherrySliccEvent(targetId, name, _) = msg else {
            return XCTFail("expected cherrySliccEvent, got \(msg)")
        }
        XCTAssertEqual(targetId, "c")
        XCTAssertEqual(name, "open-url")
    }
}
