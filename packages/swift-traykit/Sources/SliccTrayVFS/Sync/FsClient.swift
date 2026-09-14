import Foundation
import OSLog
import SliccTrayFollower

























@MainActor
public final class FsClient {
    
    public enum FsError: LocalizedError, Equatable {
        
        case leader(message: String, code: String?)
        
        case timedOut(op: String, path: String)
        
        case disconnected
        
        case unexpectedPayload(expected: String, got: String)
        
        case malformedChunking(String)

        public var errorDescription: String? {
            switch self {
            case .leader(let message, let code):
                return code.map { "\(message) (\($0))" } ?? message
            case .timedOut(let op, let path):
                return "Timed out waiting for \(op) \(path)"
            case .disconnected:
                return "Disconnected from the leader"
            case .unexpectedPayload(let expected, let got):
                return "Expected \(expected) from the leader, got \(got)"
            case .malformedChunking(let detail):
                return "Malformed chunked response: \(detail)"
            }
        }
    }

    
    
    public static let defaultTimeout: TimeInterval = 30

    
    
    static let leaderRuntimeId = "leader"

    private struct Pending {
        let request: TrayFsRequest
        let continuation: CheckedContinuation<TrayFsResponseData, Error>
        var timeoutTask: Task<Void, Never>?
        var chunks: [Int: String] = [:]
        var encoding: TrayFsWriteEncoding = .utf8
        var totalChunks: Int?
    }

    private var pending: [String: Pending] = [:]
    private let send: (FollowerToLeaderMessage) -> Bool
    private let timeout: TimeInterval
    private let makeRequestId: () -> String
    private let logger = Logger(subsystem: "ai.slicc.follower", category: "fs")

    public init(
        timeout: TimeInterval = FsClient.defaultTimeout,
        makeRequestId: @escaping () -> String = { UUID().uuidString },
        send: @escaping (FollowerToLeaderMessage) -> Bool
    ) {
        precondition(timeout > 0, "timeout must be positive")
        self.timeout = timeout
        self.makeRequestId = makeRequestId
        self.send = send
    }

    
    var inFlightCount: Int { pending.count }

    

    
    public func perform(_ request: TrayFsRequest) async throws -> TrayFsResponseData {
        let requestId = makeRequestId()
        return try await withCheckedThrowingContinuation { continuation in
            pending[requestId] = Pending(request: request, continuation: continuation)
            guard
                send(
                    .fsRequest(
                        requestId: requestId,
                        targetRuntimeId: Self.leaderRuntimeId,
                        request: request))
            else {
                
                fail(requestId, with: .disconnected)
                return
            }
            armTimeout(for: requestId, request: request)
        }
    }

    
    public func readFile(_ path: String) async throws -> String {
        let data = try await perform(.readFile(path: path, encoding: .utf8))
        guard case .file(let content, _) = data else {
            throw FsError.unexpectedPayload(expected: "file", got: data.wireType)
        }
        return content
    }

    
    public func readBinaryFile(_ path: String) async throws -> Data {
        let payload = try await perform(.readFile(path: path, encoding: .binary))
        guard case .file(let content, _) = payload else {
            throw FsError.unexpectedPayload(expected: "file", got: payload.wireType)
        }
        guard let decoded = Data(base64Encoded: content) else {
            throw FsError.malformedChunking("binary read was not valid base64")
        }
        return decoded
    }

    
    public func writeFile(_ path: String, content: String) async throws {
        try await expectVoid(
            from: .writeFile(path: path, content: content, encoding: .utf8))
    }

    
    public func writeBinaryFile(_ path: String, data: Data) async throws {
        try await expectVoid(
            from: .writeFile(
                path: path, content: data.base64EncodedString(), encoding: .base64))
    }

    
    public func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
        let data = try await perform(.readDir(path: path))
        guard case .dirEntries(let entries) = data else {
            throw FsError.unexpectedPayload(expected: "dirEntries", got: data.wireType)
        }
        return entries
    }

    
    public func stat(_ path: String) async throws -> TrayFsStat {
        let data = try await perform(.stat(path: path))
        guard case .stat(let stat) = data else {
            throw FsError.unexpectedPayload(expected: "stat", got: data.wireType)
        }
        return stat
    }

    
    public func mkdir(_ path: String, recursive: Bool = false) async throws {
        try await expectVoid(from: .mkdir(path: path, recursive: recursive))
    }

    
    public func remove(_ path: String, recursive: Bool = false) async throws {
        try await expectVoid(from: .rm(path: path, recursive: recursive))
    }

    
    func exists(_ path: String) async throws -> Bool {
        let data = try await perform(.exists(path: path))
        guard case .exists(let exists) = data else {
            throw FsError.unexpectedPayload(expected: "exists", got: data.wireType)
        }
        return exists
    }

    

    
    public func handleResponse(requestId: String, response: TrayFsResponse) {
        guard var entry = pending[requestId] else {
            
            
            return
        }

        guard response.ok else {
            fail(requestId, with: .leader(message: response.error ?? "fs error", code: response.code))
            return
        }
        guard let data = response.data else {
            fail(requestId, with: .malformedChunking("ok response carried no data"))
            return
        }

        guard let totalChunks = response.totalChunks, let chunkIndex = response.chunkIndex else {
            finish(requestId, with: data)
            return
        }

        guard case .file(let content, let encoding) = data else {
            fail(requestId, with: .malformedChunking("only file payloads chunk"))
            return
        }
        if let violation = Self.chunkViolation(
            index: chunkIndex, total: totalChunks, expected: entry.totalChunks)
        {
            fail(requestId, with: .malformedChunking(violation))
            return
        }

        entry.totalChunks = totalChunks
        entry.encoding = encoding
        entry.chunks[chunkIndex] = content
        pending[requestId] = entry

        guard entry.chunks.count == totalChunks else { return }
        let assembled = (0..<totalChunks).compactMap { entry.chunks[$0] }.joined()
        finish(requestId, with: .file(content: assembled, encoding: encoding))
    }

    
    public func cancelAll(_ reason: FsError = .disconnected) {
        let ids = Array(pending.keys)
        for id in ids { fail(id, with: reason) }
    }

    
    
    
    
    
    public static func refusal(for request: TrayFsRequest) -> TrayFsResponse {
        .failure(
            "iOS follower serves no filesystem (op \(request.op) on \(request.path))",
            code: "ENOTSUP")
    }

    

    
    private static func chunkViolation(index: Int, total: Int, expected: Int?) -> String? {
        if total <= 0 { return "totalChunks was \(total)" }
        if index < 0 || index >= total { return "chunkIndex \(index) out of range for \(total)" }
        if let expected = expected, expected != total {
            return "totalChunks changed from \(expected) to \(total) mid-stream"
        }
        return nil
    }

    private func armTimeout(for requestId: String, request: TrayFsRequest) {
        guard var entry = pending[requestId] else { return }
        let nanos = UInt64(timeout * 1_000_000_000)
        entry.timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            self?.fail(requestId, with: .timedOut(op: request.op, path: request.path))
        }
        pending[requestId] = entry
    }

    private func expectVoid(from request: TrayFsRequest) async throws {
        let data = try await perform(request)
        guard case .void = data else {
            throw FsError.unexpectedPayload(expected: "void", got: data.wireType)
        }
    }

    private func finish(_ requestId: String, with data: TrayFsResponseData) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        entry.timeoutTask?.cancel()
        entry.continuation.resume(returning: data)
    }

    private func fail(_ requestId: String, with error: FsError) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        entry.timeoutTask?.cancel()
        
        logger.error("fs \(entry.request.op) failed: \(error.localizedDescription)")
        entry.continuation.resume(throwing: error)
    }
}

extension TrayFsResponseData {
    
    var wireType: String {
        switch self {
        case .file: return "file"
        case .stat: return "stat"
        case .dirEntries: return "dirEntries"
        case .exists: return "exists"
        case .paths: return "paths"
        case .void: return "void"
        }
    }
}
