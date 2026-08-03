import Foundation
import SliccTrayKit
import UIKit

/// Follower-originated CDP against the leader's browser transport, scoped
/// to what tab previews need (#1865): attach to a target, capture a JPEG
/// screenshot, detach. Owns the request/response correlation and the
/// chunk reassembly the leader's `sendCDPResponse` produces for large
/// results — the deadline lives here too, because a dropped response
/// would otherwise hang its continuation forever (same posture as
/// `FsClient`).
@MainActor
final class CdpPreviewClient {
    /// JPEG quality asked of `Page.captureScreenshot` — preview cards, not
    /// archival captures.
    static let jpegQuality = 60
    static let requestTimeout: TimeInterval = 15

    private let send: (FollowerToLeaderMessage) -> Bool
    private var continuations: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var chunkBuffers: [String: (chunks: [Int: String], total: Int)] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]

    init(send: @escaping (FollowerToLeaderMessage) -> Bool) {
        self.send = send
    }

    enum PreviewError: Error, LocalizedError {
        case sendFailed
        case timedOut
        case leaderError(String)
        case malformed(String)

        var errorDescription: String? {
            switch self {
            case .sendFailed: return "The leader is unreachable."
            case .timedOut: return "The leader did not answer in time."
            case .leaderError(let message): return message
            case .malformed(let what): return "Unexpected CDP shape: \(what)"
            }
        }
    }

    /// Capture one preview of a leader-side target: attach → screenshot →
    /// detach (fire-and-forget). The attach is manual — auto-attach freezes
    /// popup targets, a repo-documented CDP gotcha.
    func capturePreview(targetId: String) async throws -> UIImage {
        let attach = try await request(
            targetRuntimeId: "leader", localTargetId: targetId,
            method: "Target.attachToTarget",
            params: ["targetId": targetId, "flatten": true])
        guard let sessionId = attach["sessionId"] as? String else {
            throw PreviewError.malformed("attach returned no sessionId")
        }
        defer {
            _ = send(
                .cdpRequest(
                    requestId: UUID().uuidString, targetRuntimeId: "leader",
                    localTargetId: targetId, method: "Target.detachFromTarget",
                    params: AnyCodable(["sessionId": sessionId]), sessionId: nil))
        }
        // Foreground first: Chrome returns a blank capture (without
        // throwing) for a throttled background renderer — the review
        // checklist's "foreground before screenshots" exists for exactly
        // this. Failure is non-fatal; the capture still gets attempted.
        _ = try? await request(
            targetRuntimeId: "leader", localTargetId: targetId,
            method: "Page.bringToFront", params: [:], sessionId: sessionId)
        let shot = try await request(
            targetRuntimeId: "leader", localTargetId: targetId,
            method: "Page.captureScreenshot",
            params: ["format": "jpeg", "quality": Self.jpegQuality],
            sessionId: sessionId)
        guard let base64 = shot["data"] as? String,
            let bytes = Data(base64Encoded: base64),
            let image = UIImage(data: bytes)
        else {
            throw PreviewError.malformed("screenshot returned no image data")
        }
        return image
    }

    private func request(
        targetRuntimeId: String, localTargetId: String, method: String,
        params: [String: Any], sessionId: String? = nil
    ) async throws -> [String: Any] {
        let requestId = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            continuations[requestId] = continuation
            timeouts[requestId] = Task { @MainActor [weak self] in
                try? await Task.sleep(
                    nanoseconds: UInt64(Self.requestTimeout * 1_000_000_000))
                self?.settle(requestId, with: .failure(PreviewError.timedOut))
            }
            let ok = send(
                .cdpRequest(
                    requestId: requestId, targetRuntimeId: targetRuntimeId,
                    localTargetId: localTargetId, method: method,
                    params: AnyCodable(params), sessionId: sessionId))
            if !ok {
                settle(requestId, with: .failure(PreviewError.sendFailed))
            }
        }
    }

    /// Feed one `cdp.response` from the leader. Chunked responses carry
    /// slices of the serialized result JSON; the final slice completes the
    /// request.
    func handleResponse(
        requestId: String, result: AnyCodable?, error: String?,
        chunkData: String?, chunkIndex: Int?, totalChunks: Int?
    ) {
        guard continuations[requestId] != nil else { return }
        if let error {
            settle(requestId, with: .failure(PreviewError.leaderError(error)))
            return
        }
        if let chunkData, let chunkIndex, let totalChunks {
            var buffer = chunkBuffers[requestId] ?? (chunks: [:], total: totalChunks)
            buffer.chunks[chunkIndex] = chunkData
            buffer.total = totalChunks
            chunkBuffers[requestId] = buffer
            guard buffer.chunks.count == totalChunks else { return }
            chunkBuffers[requestId] = nil
            let joined = (0..<totalChunks).compactMap { buffer.chunks[$0] }.joined()
            guard let data = joined.data(using: .utf8),
                let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                settle(
                    requestId,
                    with: .failure(PreviewError.malformed("chunked result did not parse")))
                return
            }
            settle(requestId, with: .success(parsed))
            return
        }
        settle(requestId, with: .success((result?.value as? [String: Any]) ?? [:]))
    }

    private func settle(_ requestId: String, with result: Result<[String: Any], Error>) {
        guard let continuation = continuations.removeValue(forKey: requestId) else { return }
        timeouts.removeValue(forKey: requestId)?.cancel()
        chunkBuffers[requestId] = nil
        continuation.resume(with: result)
    }
}
