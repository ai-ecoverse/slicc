import Foundation
import OSLog
import SliccTrayKit

/// Single-flight client for running commands in the leader's virtual shell.
///
/// Output stays as bytes all the way to the caller. Decoding each wire chunk to
/// a String would corrupt a multibyte UTF-8 scalar split across chunk boundaries.
@MainActor
final class TerminalClient {
    static let retainedOutputLimit = 64 * 1_024

    enum TerminalError: LocalizedError, Equatable {
        case alreadyRunning
        case cancelled
        case disconnected
        case malformedChunk
        case timedOut

        var errorDescription: String? {
            switch self {
            case .alreadyRunning: return "A terminal command is already running"
            case .cancelled: return "The terminal command was cancelled"
            case .disconnected: return "Disconnected from the leader"
            case .malformedChunk: return "The leader sent malformed terminal output"
            case .timedOut: return "Timed out waiting for the terminal command"
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
        var retainedBytes = 0
        var deadlineTask: Task<Void, Never>?
        var completionError: TerminalError?
        var interruptSent = false
    }

    private let send: (FollowerToLeaderMessage) -> Bool
    private let deadline: TimeInterval?
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let makeRequestId: () -> String
    private let logger = Logger(subsystem: "ai.slicc.follower", category: "terminal")
    private var pending: Pending?

    init(
        deadline: TimeInterval? = nil,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        },
        makeRequestId: @escaping () -> String = { UUID().uuidString },
        send: @escaping (FollowerToLeaderMessage) -> Bool
    ) {
        precondition(deadline.map { $0 > 0 } ?? true, "deadline must be positive")
        self.deadline = deadline
        self.sleep = sleep
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
            requestInterrupt(requestId: requestId, completionError: .malformedChunk)
            return
        }
        let chunk = OutputChunk(stream: outputStream, data: bytes)
        retain(chunk, in: &active)
        pending = active
        active.onChunk(chunk)
    }

    /// Finish the matching run. Non-zero exits and leader errors are terminal
    /// results, not transport failures, so callers retain any preceding output.
    func handleResponse(requestId: String, exitCode: Int, signal: String?, error: String?) {
        guard let active = pending, active.requestId == requestId else { return }
        if let completionError = active.completionError {
            fail(requestId, with: completionError)
            return
        }
        finish(
            requestId,
            with: RunResult(
                chunks: active.chunks, exitCode: exitCode, signal: signal, error: error))
    }

    /// Interrupt the active leader command. The local waiter stays pending until
    /// the matching response confirms the persistent leader shell is idle.
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
                        requestId: requestId, command: command, cwd: cwd, env: env, stdin: nil))
            else {
                fail(requestId, with: .disconnected)
                return
            }
            armDeadline(for: requestId)
            if Task.isCancelled { cancel(requestId: requestId) }
        }
    }

    private func armDeadline(for requestId: String) {
        guard let deadline, var active = pending, active.requestId == requestId else { return }
        let nanoseconds = UInt64(deadline * 1_000_000_000)
        active.deadlineTask = Task { @MainActor [weak self, sleep] in
            try? await sleep(nanoseconds)
            guard !Task.isCancelled else { return }
            self?.expire(requestId)
        }
        pending = active
    }

    private func expire(_ requestId: String) {
        requestInterrupt(requestId: requestId, completionError: .timedOut)
    }

    private func retain(_ chunk: OutputChunk, in active: inout Pending) {
        let data =
            chunk.data.count > Self.retainedOutputLimit
            ? Data(chunk.data.suffix(Self.retainedOutputLimit)) : chunk.data
        active.chunks.append(OutputChunk(stream: chunk.stream, data: data))
        active.retainedBytes += data.count
        var excess = active.retainedBytes - Self.retainedOutputLimit
        while excess > 0, let first = active.chunks.first {
            if first.data.count <= excess {
                excess -= first.data.count
                active.retainedBytes -= first.data.count
                active.chunks.removeFirst()
            } else {
                active.chunks[0] = OutputChunk(
                    stream: first.stream, data: Data(first.data.dropFirst(excess)))
                active.retainedBytes -= excess
                excess = 0
            }
        }
    }

    @discardableResult
    private func cancel(requestId: String) -> Bool {
        requestInterrupt(requestId: requestId, completionError: .cancelled)
    }

    @discardableResult
    private func requestInterrupt(
        requestId: String, completionError: TerminalError
    ) -> Bool {
        guard var active = pending, active.requestId == requestId else { return false }
        if active.completionError == nil { active.completionError = completionError }
        active.deadlineTask?.cancel()
        guard !active.interruptSent else {
            pending = active
            return true
        }
        active.interruptSent = true
        pending = active
        guard send(.execSignal(requestId: requestId, signal: "SIGINT")) else {
            fail(requestId, with: .disconnected)
            return false
        }
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
        active.deadlineTask?.cancel()
        return active
    }
}
