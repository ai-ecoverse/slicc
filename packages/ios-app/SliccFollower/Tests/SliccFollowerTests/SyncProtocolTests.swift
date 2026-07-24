import XCTest
import Foundation
@testable import SliccFollower

// Compiled into the `SliccFollowerTests` bundle (see project.yml) and run in CI
// via `xcodebuild test` on an iOS Simulator — `swift test` cannot run on a plain
// macOS host because the package depends on an iOS-only WebRTC binary. The
// golden-fixture corpus suite lives in SyncProtocolCorpusTests.swift.
// MARK: - Task 8: Transcript export iOS safety

/// Verify that export response messages from the leader do NOT tear down the
/// tray session — iOS decodes them to `.unknown` and ignores them safely.
final class SyncProtocolTranscriptExportTests: XCTestCase {
    private let exportTypes = [
        "transcript.export.pending",
        "transcript.export.denied",
        "transcript.export.start",
        "transcript.export.chunk",
        "transcript.export.complete",
        "transcript.export.error",
    ]

    func testExportResponseMessagesDecodeToUnknown() throws {
        for msgType in exportTypes {
            let json = """
            {"type":"\(msgType)","requestId":"te-1"}
            """.data(using: .utf8)!
            let msg = try JSONDecoder().decode(LeaderToFollowerMessage.self, from: json)
            guard case let .unknown(type) = msg else {
                XCTFail("\(msgType) should decode to .unknown, got \(msg)")
                continue
            }
            XCTAssertEqual(type, msgType)
        }
    }

    func testExportRequestMessagesThrowOnDecode() throws {
        let requestVariants = [
            "{\"type\":\"transcript.export.request\",\"requestId\":\"te-1\","
                + "\"selector\":{\"kind\":\"active\"}}",
            "{\"type\":\"transcript.export.cancel\",\"requestId\":\"te-1\"}",
        ]
        for jsonStr in requestVariants {
            let json = jsonStr.data(using: .utf8)!
            XCTAssertThrowsError(
                try JSONDecoder().decode(FollowerToLeaderMessage.self, from: json),
                "FollowerToLeaderMessage should throw for export variants iOS never originates"
            )
        }
    }
}

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
        XCTAssertEqual(target.capabilities?.screenshot, true)
    }

    func testCherrySliccEventMessageDecodes() throws {
        let json = """
        {"type":"cherry.slicc_event","targetId":"c","name":"open-url","detail":{"url":"https://x"}}
        """.data(using: .utf8)!
        let msg = try JSONDecoder().decode(LeaderToFollowerMessage.self, from: json)
        guard case let .cherrySliccEvent(targetId, name, detail) = msg else {
            return XCTFail("expected cherrySliccEvent, got \(msg)")
        }
        XCTAssertEqual(targetId, "c")
        XCTAssertEqual(name, "open-url")
        XCTAssertNotNil(detail, "detail should decode the {\"url\":...} payload")
    }
}
