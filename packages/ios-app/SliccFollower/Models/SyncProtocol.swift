import Foundation

// MARK: - AgentEvent

/// Mirrors AgentEvent from packages/webapp/src/ui/types.ts
enum AgentEvent: Codable {
    case messageStart(messageId: String)
    case contentDelta(messageId: String, text: String)
    case contentDone(messageId: String)
    case toolUseStart(messageId: String, toolName: String, toolInput: AnyCodable?)
    case toolResult(messageId: String, toolName: String, result: String, isError: Bool?)
    case turnEnd(messageId: String)
    case error(error: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, messageId, text, toolName, toolInput, result, isError, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message_start":
            self = .messageStart(messageId: try container.decode(String.self, forKey: .messageId))
        case "content_delta":
            self = .contentDelta(
                messageId: try container.decode(String.self, forKey: .messageId),
                text: try container.decode(String.self, forKey: .text))
        case "content_done":
            self = .contentDone(messageId: try container.decode(String.self, forKey: .messageId))
        case "tool_use_start":
            self = .toolUseStart(
                messageId: try container.decode(String.self, forKey: .messageId),
                toolName: try container.decode(String.self, forKey: .toolName),
                toolInput: try container.decodeIfPresent(AnyCodable.self, forKey: .toolInput))
        case "tool_result":
            self = .toolResult(
                messageId: try container.decode(String.self, forKey: .messageId),
                toolName: try container.decode(String.self, forKey: .toolName),
                result: try container.decode(String.self, forKey: .result),
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError))
        case "turn_end":
            self = .turnEnd(messageId: try container.decode(String.self, forKey: .messageId))
        case "error":
            self = .error(error: try container.decode(String.self, forKey: .error))
        default:
            self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .messageStart(messageId):
            try container.encode("message_start", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
        case let .contentDelta(messageId, text):
            try container.encode("content_delta", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(text, forKey: .text)
        case let .contentDone(messageId):
            try container.encode("content_done", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
        case let .toolUseStart(messageId, toolName, toolInput):
            try container.encode("tool_use_start", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(toolName, forKey: .toolName)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)
        case let .toolResult(messageId, toolName, result, isError):
            try container.encode("tool_result", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(result, forKey: .result)
            try container.encodeIfPresent(isError, forKey: .isError)
        case let .turnEnd(messageId):
            try container.encode("turn_end", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
        case let .error(error):
            try container.encode("error", forKey: .type)
            try container.encode(error, forKey: .error)
        case let .unknown(type):
            try container.encode(type, forKey: .type)
        }
    }
}

// MARK: - ScoopSummary / SprinkleSummary

/// Mirrors ScoopSummary from tray-sync-protocol.ts
struct ScoopSummary: Codable, Identifiable, Hashable {
    let jid: String
    let name: String
    let folder: String
    let isCone: Bool
    let assistantLabel: String
    let trigger: String?

    var id: String { jid }
}

/// Mirrors SprinkleSummary from tray-sync-protocol.ts
struct SprinkleSummary: Codable, Identifiable, Hashable {
    let name: String
    let title: String
    let path: String
    let open: Bool
    let autoOpen: Bool

    var id: String { name }
}

// MARK: - LeaderToFollowerMessage

/// Mirrors LeaderToFollowerMessage from tray-sync-protocol.ts
/// (cdp.*, tab.*, fs.*, targets.* variants omitted — not needed for basic follower)
enum LeaderToFollowerMessage: Codable {
    case snapshot(messages: [ChatMessage], scoopJid: String)
    case snapshotChunk(chunkData: String, chunkIndex: Int, totalChunks: Int, scoopJid: String)
    case agentEvent(event: AgentEvent, scoopJid: String)
    case userMessageEcho(text: String, messageId: String, scoopJid: String)
    case status(scoopStatus: String)
    case error(error: String)
    case scoopsList(scoops: [ScoopSummary], activeScoopJid: String)
    case sprinklesList(sprinkles: [SprinkleSummary])
    case sprinkleContent(
        requestId: String,
        sprinkleName: String,
        content: String,
        chunkIndex: Int?,
        totalChunks: Int?,
        error: String?)
    case sprinkleUpdate(sprinkleName: String, data: AnyCodable?)
    case ping
    case pong
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, messages, scoopJid, chunkData, chunkIndex, totalChunks
        case event, text, messageId, scoopStatus, error
        case scoops, activeScoopJid, sprinkles
        case requestId, sprinkleName, content, data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            self = .snapshot(
                messages: (try? container.decode([ChatMessage].self, forKey: .messages)) ?? [],
                scoopJid: (try? container.decode(String.self, forKey: .scoopJid)) ?? "")
        case "snapshot_chunk":
            self = .snapshotChunk(
                chunkData: try container.decode(String.self, forKey: .chunkData),
                chunkIndex: try container.decode(Int.self, forKey: .chunkIndex),
                totalChunks: try container.decode(Int.self, forKey: .totalChunks),
                scoopJid: try container.decode(String.self, forKey: .scoopJid))
        case "agent_event":
            self = .agentEvent(
                event: try container.decode(AgentEvent.self, forKey: .event),
                scoopJid: try container.decode(String.self, forKey: .scoopJid))
        case "user_message_echo":
            self = .userMessageEcho(
                text: try container.decode(String.self, forKey: .text),
                messageId: try container.decode(String.self, forKey: .messageId),
                scoopJid: try container.decode(String.self, forKey: .scoopJid))
        case "status":
            self = .status(scoopStatus: try container.decode(String.self, forKey: .scoopStatus))
        case "error":
            self = .error(error: try container.decode(String.self, forKey: .error))
        case "scoops.list":
            self = .scoopsList(
                scoops: (try? container.decode([ScoopSummary].self, forKey: .scoops)) ?? [],
                activeScoopJid: (try? container.decode(String.self, forKey: .activeScoopJid)) ?? ""
            )
        case "sprinkles.list":
            self = .sprinklesList(
                sprinkles: (try? container.decode([SprinkleSummary].self, forKey: .sprinkles)) ?? []
            )
        case "sprinkle.content":
            self = .sprinkleContent(
                requestId: try container.decode(String.self, forKey: .requestId),
                sprinkleName: try container.decode(String.self, forKey: .sprinkleName),
                content: (try? container.decode(String.self, forKey: .content)) ?? "",
                chunkIndex: try container.decodeIfPresent(Int.self, forKey: .chunkIndex),
                totalChunks: try container.decodeIfPresent(Int.self, forKey: .totalChunks),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
        case "sprinkle.update":
            self = .sprinkleUpdate(
                sprinkleName: try container.decode(String.self, forKey: .sprinkleName),
                data: try container.decodeIfPresent(AnyCodable.self, forKey: .data)
            )
        case "ping":
            self = .ping
        case "pong":
            self = .pong
        default:
            self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .snapshot(messages, scoopJid):
            try container.encode("snapshot", forKey: .type)
            try container.encode(messages, forKey: .messages)
            try container.encode(scoopJid, forKey: .scoopJid)
        case let .snapshotChunk(chunkData, chunkIndex, totalChunks, scoopJid):
            try container.encode("snapshot_chunk", forKey: .type)
            try container.encode(chunkData, forKey: .chunkData)
            try container.encode(chunkIndex, forKey: .chunkIndex)
            try container.encode(totalChunks, forKey: .totalChunks)
            try container.encode(scoopJid, forKey: .scoopJid)
        case let .agentEvent(event, scoopJid):
            try container.encode("agent_event", forKey: .type)
            try container.encode(event, forKey: .event)
            try container.encode(scoopJid, forKey: .scoopJid)
        case let .userMessageEcho(text, messageId, scoopJid):
            try container.encode("user_message_echo", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(scoopJid, forKey: .scoopJid)
        case let .status(scoopStatus):
            try container.encode("status", forKey: .type)
            try container.encode(scoopStatus, forKey: .scoopStatus)
        case let .error(error):
            try container.encode("error", forKey: .type)
            try container.encode(error, forKey: .error)
        case let .scoopsList(scoops, activeScoopJid):
            try container.encode("scoops.list", forKey: .type)
            try container.encode(scoops, forKey: .scoops)
            try container.encode(activeScoopJid, forKey: .activeScoopJid)
        case let .sprinklesList(sprinkles):
            try container.encode("sprinkles.list", forKey: .type)
            try container.encode(sprinkles, forKey: .sprinkles)
        case let .sprinkleContent(requestId, sprinkleName, content, chunkIndex, totalChunks, error):
            try container.encode("sprinkle.content", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encode(content, forKey: .content)
            try container.encodeIfPresent(chunkIndex, forKey: .chunkIndex)
            try container.encodeIfPresent(totalChunks, forKey: .totalChunks)
            try container.encodeIfPresent(error, forKey: .error)
        case let .sprinkleUpdate(sprinkleName, data):
            try container.encode("sprinkle.update", forKey: .type)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encodeIfPresent(data, forKey: .data)
        case .ping:
            try container.encode("ping", forKey: .type)
        case .pong:
            try container.encode("pong", forKey: .type)
        case let .unknown(type):
            try container.encode(type, forKey: .type)
        }
    }
}

// MARK: - FollowerToLeaderMessage

/// Mirrors FollowerToLeaderMessage from tray-sync-protocol.ts
/// (cdp.*, tab.*, fs.*, targets.* variants omitted — not needed for basic follower)
enum FollowerToLeaderMessage: Codable {
    case userMessage(text: String, messageId: String)
    case abort
    case requestSnapshot(scoopJid: String?)
    case scoopsSelect(scoopJid: String)
    case sprinklesRefresh
    case sprinkleFetch(requestId: String, sprinkleName: String)
    case sprinkleLick(sprinkleName: String, body: AnyCodable?, targetScoop: String?)
    case ping
    case pong

    private enum CodingKeys: String, CodingKey {
        case type, text, messageId, scoopJid
        case requestId, sprinkleName, body, targetScoop
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user_message":
            self = .userMessage(
                text: try container.decode(String.self, forKey: .text),
                messageId: try container.decode(String.self, forKey: .messageId))
        case "abort":
            self = .abort
        case "request_snapshot":
            self = .requestSnapshot(
                scoopJid: try container.decodeIfPresent(String.self, forKey: .scoopJid))
        case "scoops.select":
            self = .scoopsSelect(scoopJid: try container.decode(String.self, forKey: .scoopJid))
        case "sprinkles.refresh":
            self = .sprinklesRefresh
        case "sprinkle.fetch":
            self = .sprinkleFetch(
                requestId: try container.decode(String.self, forKey: .requestId),
                sprinkleName: try container.decode(String.self, forKey: .sprinkleName))
        case "sprinkle.lick":
            self = .sprinkleLick(
                sprinkleName: try container.decode(String.self, forKey: .sprinkleName),
                body: try container.decodeIfPresent(AnyCodable.self, forKey: .body),
                targetScoop: try container.decodeIfPresent(String.self, forKey: .targetScoop))
        case "ping":
            self = .ping
        case "pong":
            self = .pong
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "Unknown FollowerToLeaderMessage type: \(type)"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .userMessage(text, messageId):
            try container.encode("user_message", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode(messageId, forKey: .messageId)
        case .abort:
            try container.encode("abort", forKey: .type)
        case let .requestSnapshot(scoopJid):
            try container.encode("request_snapshot", forKey: .type)
            try container.encodeIfPresent(scoopJid, forKey: .scoopJid)
        case let .scoopsSelect(scoopJid):
            try container.encode("scoops.select", forKey: .type)
            try container.encode(scoopJid, forKey: .scoopJid)
        case .sprinklesRefresh:
            try container.encode("sprinkles.refresh", forKey: .type)
        case let .sprinkleFetch(requestId, sprinkleName):
            try container.encode("sprinkle.fetch", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(sprinkleName, forKey: .sprinkleName)
        case let .sprinkleLick(sprinkleName, body, targetScoop):
            try container.encode("sprinkle.lick", forKey: .type)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encodeIfPresent(body, forKey: .body)
            try container.encodeIfPresent(targetScoop, forKey: .targetScoop)
        case .ping:
            try container.encode("ping", forKey: .type)
        case .pong:
            try container.encode("pong", forKey: .type)
        }
    }
}

