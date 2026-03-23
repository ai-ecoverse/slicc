import Foundation
import Hummingbird
import HummingbirdWebSocket

public struct WebSocketClient: Hashable, Sendable {
    public let id: UUID
    private let sendTextClosure: @Sendable (String) async throws -> Void

    public init(id: UUID = UUID(), sendText: @escaping @Sendable (String) async throws -> Void) {
        self.id = id
        self.sendTextClosure = sendText
    }

    public static func == (lhs: WebSocketClient, rhs: WebSocketClient) -> Bool { lhs.id == rhs.id }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(self.id)
    }

    public func send(text: String) async throws {
        try await self.sendTextClosure(text)
    }
}

public enum LickSystemError: Error, LocalizedError, Sendable, Equatable {
    case noBrowserConnected
    case requestTimeout(requestId: String, timeout: TimeInterval)
    case remoteError(String)

    public var errorDescription: String? {
        switch self {
        case .noBrowserConnected:
            return "No browser connected"
        case .requestTimeout:
            return "Request timeout"
        case .remoteError(let message):
            return message
        }
    }
}

public actor LickSystem {
    public enum JSONValue: Codable, Equatable, Sendable, CustomStringConvertible {
        case string(String)
        case number(Double)
        case bool(Bool)
        case object([String: JSONValue])
        case array([JSONValue])
        case null

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { self = .null }
            else if let value = try? container.decode(Bool.self) { self = .bool(value) }
            else if let value = try? container.decode(String.self) { self = .string(value) }
            else if let value = try? container.decode(Double.self) { self = .number(value) }
            else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
            else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
            else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .string(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            case .bool(let value): try container.encode(value)
            case .object(let value): try container.encode(value)
            case .array(let value): try container.encode(value)
            case .null: try container.encodeNil()
            }
        }

        public var description: String {
            switch self {
            case .string(let value): return value
            case .number(let value): return String(value)
            case .bool(let value): return String(value)
            case .object(let value): return String(describing: value)
            case .array(let value): return String(describing: value)
            case .null: return "null"
            }
        }

        var stringValue: String? {
            guard case .string(let value) = self else { return nil }
            return value
        }
    }

    public typealias JSONObject = [String: JSONValue]

    private struct PendingRequest {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeoutTask: Task<Void, Never>
    }

    private var clients: Set<WebSocketClient> = []
    private var pendingRequests: [String: PendingRequest] = [:]
    private var requestCounter: Int = 0

    public init() {}

    public func addClient(_ ws: WebSocketClient) {
        self.clients.insert(ws)
    }

    public func removeClient(_ ws: WebSocketClient) {
        self.clients.remove(ws)
    }

    public func sendRequest(type: String, data: JSONObject = [:], timeout: TimeInterval = 5) async throws -> JSONValue {
        guard let client = self.clients.first else {
            throw LickSystemError.noBrowserConnected
        }

        let requestId = self.nextRequestId()
        var payload = data
        payload["type"] = .string(type)
        payload["requestId"] = .string(requestId)
        let message = try Self.encode(payload)

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task {
                let timeoutNanoseconds = UInt64(max(timeout, 0) * 1_000_000_000)
                if timeoutNanoseconds > 0 {
                    try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                }
                await self.failPendingRequest(
                    requestId,
                    error: LickSystemError.requestTimeout(requestId: requestId, timeout: timeout)
                )
            }

            self.pendingRequests[requestId] = PendingRequest(
                continuation: continuation,
                timeoutTask: timeoutTask
            )

            Task {
                do {
                    try await client.send(text: message)
                } catch {
                    self.removeClient(client)
                    self.failPendingRequest(requestId, error: error)
                }
            }
        }
    }

    public func sendLickRequest(type: String, data: JSONObject = [:], timeout: TimeInterval = 5) async throws -> JSONValue {
        try await self.sendRequest(type: type, data: data, timeout: timeout)
    }

    public func broadcastEvent(_ event: JSONObject) {
        guard !self.clients.isEmpty, let message = try? Self.encode(event) else { return }
        let clients = Array(self.clients)
        for client in clients {
            Task {
                do {
                    try await client.send(text: message)
                } catch {
                    self.removeClient(client)
                }
            }
        }
    }

    public func broadcastLickEvent(_ event: JSONObject) {
        self.broadcastEvent(event)
    }

    public func handleMessage(text: String) async {
        guard let payload = try? Self.decode(text),
              payload["type"]?.stringValue == "response",
              let requestId = payload["requestId"]?.stringValue else {
            return
        }

        if let errorValue = payload["error"] {
            self.failPendingRequest(requestId, error: LickSystemError.remoteError(errorValue.description))
        } else {
            self.resolvePendingRequest(requestId, with: payload["data"] ?? .null)
        }
    }

    private func nextRequestId() -> String {
        self.requestCounter += 1
        return "req_\(self.requestCounter)"
    }

    private func resolvePendingRequest(_ requestId: String, with value: JSONValue) {
        guard let pending = self.pendingRequests.removeValue(forKey: requestId) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(returning: value)
    }

    private func failPendingRequest(_ requestId: String, error: Error) {
        guard let pending = self.pendingRequests.removeValue(forKey: requestId) else { return }
        pending.timeoutTask.cancel()
        pending.continuation.resume(throwing: error)
    }

    static func encode(_ payload: JSONObject) throws -> String {
        let data = try JSONEncoder().encode(payload)
        guard let string = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileWriteInapplicableStringEncoding)
        }
        return string
    }

    static func decode(_ text: String) throws -> JSONObject {
        let data = Data(text.utf8)
        return try JSONDecoder().decode(JSONObject.self, from: data)
    }
}

public enum LickWebSocketRoute {
    public static let path: RouterPath = "/licks-ws"
    public static let defaultMaxMessageSize = 1 << 20

    public static func makeRouter(
        lickSystem: LickSystem,
        maxMessageSize: Int = defaultMaxMessageSize
    ) -> Router<BasicWebSocketRequestContext> {
        let router = Router(context: BasicWebSocketRequestContext.self)
        self.register(on: router, lickSystem: lickSystem, maxMessageSize: maxMessageSize)
        return router
    }

    public static func register<Context: WebSocketRequestContext>(
        on router: Router<Context>,
        lickSystem: LickSystem,
        maxMessageSize: Int = defaultMaxMessageSize
    ) {
        router.ws(self.path) { _, _ in
            .upgrade()
        } onUpgrade: { inbound, outbound, context in
            let client = WebSocketClient {
                try await outbound.write(.text($0))
            }
            await lickSystem.addClient(client)

            do {
                for try await message in inbound.messages(maxSize: maxMessageSize) {
                    guard case .text(let text) = message else { continue }
                    await lickSystem.handleMessage(text: text)
                }
            } catch {
                context.logger.debug("Lick WebSocket closed", metadata: ["error": .string("\(error)")])
            }

            await lickSystem.removeClient(client)
        }
    }
}