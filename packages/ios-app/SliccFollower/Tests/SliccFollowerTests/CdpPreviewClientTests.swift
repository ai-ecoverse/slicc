import UIKit
import XCTest

@testable import SliccFollower

/// Follower-originated CDP for tab previews (#1865): request/response
/// correlation, chunk reassembly, and failure surfacing.
@MainActor
final class CdpPreviewClientTests: XCTestCase {

    private func jpegBase64() -> String {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(
            size: CGSize(width: 8, height: 8), format: format
        ).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        return image.jpegData(compressionQuality: 0.9)!.base64EncodedString()
    }

    func testCapturePreviewAttachesShootsAndDetaches() async throws {
        var sent: [FollowerToLeaderMessage] = []
        let client = CdpPreviewClient { message in
            sent.append(message)
            return true
        }

        async let capture = client.capturePreview(targetId: "tab1")
        // Let the attach request land, then answer it.
        while sent.isEmpty { await Task.yield() }
        guard
            case .cdpRequest(let attachId, "leader", "tab1", "Target.attachToTarget", _, _) =
                sent[0]
        else { return XCTFail("first request must attach: \(sent[0])") }
        client.handleResponse(
            requestId: attachId, result: AnyCodable(["sessionId": "s1"]), error: nil,
            chunkData: nil, chunkIndex: nil, totalChunks: nil)

        while sent.count < 2 { await Task.yield() }
        guard
            case .cdpRequest(
                let shotId, "leader", "tab1", "Page.captureScreenshot", _, let sessionId) = sent[1]
        else { return XCTFail("second request must capture: \(sent[1])") }
        XCTAssertEqual(sessionId, "s1", "the capture rides the attached session")
        client.handleResponse(
            requestId: shotId, result: AnyCodable(["data": jpegBase64()]), error: nil,
            chunkData: nil, chunkIndex: nil, totalChunks: nil)

        let image = try await capture
        XCTAssertGreaterThan(image.size.width, 0)
        while sent.count < 3 { await Task.yield() }
        guard case .cdpRequest(_, "leader", _, "Target.detachFromTarget", _, _) = sent[2]
        else { return XCTFail("the session detaches after capture: \(sent[2])") }
    }

    func testChunkedResponsesReassembleInOrder() async throws {
        var sent: [FollowerToLeaderMessage] = []
        let client = CdpPreviewClient { message in
            sent.append(message)
            return true
        }
        async let capture = client.capturePreview(targetId: "tab2")
        while sent.isEmpty { await Task.yield() }
        guard case .cdpRequest(let attachId, _, _, _, _, _) = sent[0] else {
            return XCTFail()
        }
        // The serialized result arrives as out-of-order slices.
        let serialized = #"{"sessionId":"s2"}"#
        let mid = serialized.index(serialized.startIndex, offsetBy: 7)
        client.handleResponse(
            requestId: attachId, result: nil, error: nil,
            chunkData: String(serialized[mid...]), chunkIndex: 1, totalChunks: 2)
        client.handleResponse(
            requestId: attachId, result: nil, error: nil,
            chunkData: String(serialized[..<mid]), chunkIndex: 0, totalChunks: 2)

        while sent.count < 2 { await Task.yield() }
        guard case .cdpRequest(let shotId, _, _, "Page.captureScreenshot", _, "s2") = sent[1]
        else { return XCTFail("chunked attach result must parse: \(sent[1])") }
        client.handleResponse(
            requestId: shotId, result: AnyCodable(["data": jpegBase64()]), error: nil,
            chunkData: nil, chunkIndex: nil, totalChunks: nil)
        _ = try await capture
    }

    func testLeaderErrorSurfaces() async {
        var sent: [FollowerToLeaderMessage] = []
        let client = CdpPreviewClient { message in
            sent.append(message)
            return true
        }
        async let capture = client.capturePreview(targetId: "tab3")
        while sent.isEmpty { await Task.yield() }
        guard case .cdpRequest(let attachId, _, _, _, _, _) = sent[0] else {
            return XCTFail()
        }
        client.handleResponse(
            requestId: attachId, result: nil, error: "Leader has no browser transport",
            chunkData: nil, chunkIndex: nil, totalChunks: nil)
        do {
            _ = try await capture
            XCTFail("a leader error must throw")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("no browser transport"))
        }
    }

    func testRefusedSendFailsImmediately() async {
        let client = CdpPreviewClient { _ in false }
        do {
            _ = try await client.capturePreview(targetId: "tab4")
            XCTFail("a refused send must throw")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("unreachable"))
        }
    }
}
