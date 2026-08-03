import Foundation
import OSLog

/// Single-flight client for running commands in the leader's virtual shell.
///
/// Output stays as bytes all the way to the caller. Decoding each wire chunk to
/// a String would corrupt a multibyte UTF-8 scalar split across chunk boundaries.
@MainActor
final class TerminalClient {
    enum TerminalError: LocalizedError, Equatable {
        case alreadyRunning
        case cancelled
        case disconnected
        case malformedChunk

        var errorDescription: String? {
            switch self {
            case .alreadyRunning: return "A terminal command is already running"
            case .cancelled: return "The terminal command was cancelled"
            case .disconnected: return "Disconnected from the leader"
            case .malformedChunk: return "The leader sent malformed terminal output"
            }
        }
    }

    enum Stream: String, Equatable {
        case stdout
        case stderr
    }

    struct OutputChunk: Equatable {
        let stream: Stream
        let data: Data
    }

    struct RunResult: Equatable {
        let chunks: [OutputChunk]
        let exitCode: Int
        let signal: String?
        let error: String?

        var stdout: Data { data(for: .stdout) }
        var stderr: Data { data(for: .stderr) }

        private func data(for stream: Stream) -> Data {
            chunks.filter { $0.stream == stream }.reduce(into: Data()) { result, chunk in
                result.append(chunk.data)
            }
        }
    }

    private struct Pending {
        let requestId: String
        let continuation: CheckedContinuation<RunResult, Error>
        let onChunk: (OutputChunk) -> Void
        var chunks: [OutputChunk] = []
    }

    private let send: (FollowerToLeaderMessage) -> Bool
    private let makeRequestId: () -> String
    private let logger = Logger(subsystem: "ai.slicc.follower", category: "terminal")
    private var pending: Pending?

    init(
        makeRequestId: @escaping () -> String = { UUID().uuidString },
        send: @escaping (FollowerToLeaderMessage) -> Bool
    ) {
        self.makeRequestId = makeRequestId
        self.send = send
    }

    var isRunning: Bool { pending != nil }

    /// Run one command on the leader. A second concurrent run fails rather than
    /// stealing the first run's output or response.
    func run(
        command: String,
        cwd: String? = nil,
        env: [String: String]? = nil,
        onChunk: @escaping (OutputChunk) -> Void = { _ in }
    ) async throws -> RunResult {
        try Task.checkCancellation()
        guard pending == nil else { throw TerminalError.alreadyRunning }
        let requestId = makeRequestId()
        return try await withTaskCancellationHandler {
            try await beginRun(
                requestId: requestId, command: command, cwd: cwd, env: env,
                onChunk: onChunk)
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(requestId: requestId) }
        }
    }

    /// Feed one streamed output chunk from the leader.
    func handleChunk(requestId: String, stream: String, base64Data: String) {
        guard var active = pending, active.requestId == requestId else { return }
        guard let outputStream = Stream(rawValue: stream),
            let bytes = Data(base64Encoded: base64Data)
        else {
            _ = send(.execSignal(requestId: requestId, signal: "SIGINT"))
            fail(requestId, with: .malformedChunk)
            return
        }
        let chunk = OutputChunk(stream: outputStream, data: bytes)
        active.chunks.append(chunk)
        pending = active
        active.onChunk(chunk)
    }

    /// Finish the matching run. Non-zero exits and leader errors are terminal
    /// results, not transport failures, so callers retain any preceding output.
    func handleResponse(requestId: String, exitCode: Int, signal: String?, error: String?) {
        guard let active = pending, active.requestId == requestId else { return }
        finish(
            requestId,
            with: RunResult(
                chunks: active.chunks, exitCode: exitCode, signal: signal, error: error))
    }

    /// Interrupt the active leader command and finish the local waiter.
    @discardableResult
    func cancel() -> Bool {
        guard let requestId = pending?.requestId else { return false }
        return cancel(requestId: requestId)
    }

    /// Fail the active run immediately when its transport disappears.
    func disconnect() {
        guard let requestId = pending?.requestId else { return }
        fail(requestId, with: .disconnected)
    }

    /// iOS can request leader execution but cannot serve a leader command on
    /// the phone. Reply instead of leaving the leader's waiter suspended.
    func refuseLeaderRequest(requestId: String) {
        _ = send(
            .execResponse(
                requestId: requestId, exitCode: 127, signal: nil,
                error: "exec is not supported on this follower"))
    }

    private func beginRun(
        requestId: String,
        command: String,
        cwd: String?,
        env: [String: String]?,
        onChunk: @escaping (OutputChunk) -> Void
    ) async throws -> RunResult {
        guard pending == nil else { throw TerminalError.alreadyRunning }
        return try await withCheckedThrowingContinuation { continuation in
            pending = Pending(
                requestId: requestId, continuation: continuation, onChunk: onChunk)
            guard
                send(
                    .execRequest(
                        requestId: requestId, command: command, cwd: cwd, env: env))
            else {
                fail(requestId, with: .disconnected)
                return
            }
            if Task.isCancelled { cancel(requestId: requestId) }
        }
    }

    @discardableResult
    private func cancel(requestId: String) -> Bool {
        guard pending?.requestId == requestId else { return false }
        _ = send(.execSignal(requestId: requestId, signal: "SIGINT"))
        fail(requestId, with: .cancelled)
        return true
    }

    private func finish(_ requestId: String, with result: RunResult) {
        guard let active = takePending(requestId) else { return }
        active.continuation.resume(returning: result)
    }

    private func fail(_ requestId: String, with error: TerminalError) {
        guard let active = takePending(requestId) else { return }
        logger.error("Terminal command failed: \(error.localizedDescription)")
        active.continuation.resume(throwing: error)
    }

    private func takePending(_ requestId: String) -> Pending? {
        guard let active = pending, active.requestId == requestId else { return nil }
        pending = nil
        return active
    }
}
