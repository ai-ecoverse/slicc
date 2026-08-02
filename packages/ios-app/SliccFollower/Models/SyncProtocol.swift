import Foundation
import UIKit

/// The three `new_session` dispositions, mirroring
/// `packages/shared-ts/src/tray-sync-protocol.ts`.
enum NewSessionAction: String, Codable {
    case save, skip, erase
}

/// Mirrors `TRAY_SYNC_PROTOCOL_VERSION` from
/// packages/shared-ts/src/tray-sync-protocol.ts. Exchanged
/// via the additive `hello` message both sides send on channel open.
let traySyncProtocolVersion = 4

// MARK: - AgentEvent

/// Mirrors AgentEvent from packages/shared-ts/src/agent-wire-types.ts
enum AgentEvent: Codable {
    case messageStart(messageId: String)
    case contentDelta(messageId: String, text: String)
    case contentDone(messageId: String, model: String?, usage: ChatMessageUsage?)
    case toolUseStart(messageId: String, toolName: String, toolInput: AnyCodable?)
    case toolResult(messageId: String, toolName: String, result: String, isError: Bool?)
    case toolUI(messageId: String, toolName: String, requestId: String, html: String)
    case toolUIDone(messageId: String, requestId: String)
    case turnEnd(messageId: String)
    case error(error: String)
    case screenshot(base64: String, url: String?)
    case terminalOutput(text: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, messageId, text, toolName, toolInput, result, isError, error
        case model, usage, requestId, html, base64, url
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
            self = .contentDone(
                messageId: try container.decode(String.self, forKey: .messageId),
                model: try container.decodeIfPresent(String.self, forKey: .model),
                usage: try container.decodeIfPresent(ChatMessageUsage.self, forKey: .usage))
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
        case "tool_ui":
            self = .toolUI(
                messageId: try container.decode(String.self, forKey: .messageId),
                toolName: try container.decode(String.self, forKey: .toolName),
                requestId: try container.decode(String.self, forKey: .requestId),
                html: try container.decode(String.self, forKey: .html))
        case "tool_ui_done":
            self = .toolUIDone(
                messageId: try container.decode(String.self, forKey: .messageId),
                requestId: try container.decode(String.self, forKey: .requestId))
        case "turn_end":
            self = .turnEnd(messageId: try container.decode(String.self, forKey: .messageId))
        case "error":
            self = .error(error: try container.decode(String.self, forKey: .error))
        case "screenshot":
            self = .screenshot(
                base64: try container.decode(String.self, forKey: .base64),
                url: try container.decodeIfPresent(String.self, forKey: .url))
        case "terminal_output":
            self = .terminalOutput(text: try container.decode(String.self, forKey: .text))
        default:
            self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .messageStart(let messageId):
            try container.encode("message_start", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
        case .contentDelta(let messageId, let text):
            try container.encode("content_delta", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(text, forKey: .text)
        case .contentDone(let messageId, let model, let usage):
            try container.encode("content_done", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encodeIfPresent(model, forKey: .model)
            try container.encodeIfPresent(usage, forKey: .usage)
        case .toolUseStart(let messageId, let toolName, let toolInput):
            try container.encode("tool_use_start", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(toolName, forKey: .toolName)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)
        case .toolResult(let messageId, let toolName, let result, let isError):
            try container.encode("tool_result", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(result, forKey: .result)
            try container.encodeIfPresent(isError, forKey: .isError)
        case .toolUI(let messageId, let toolName, let requestId, let html):
            try container.encode("tool_ui", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(html, forKey: .html)
        case .toolUIDone(let messageId, let requestId):
            try container.encode("tool_ui_done", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(requestId, forKey: .requestId)
        case .turnEnd(let messageId):
            try container.encode("turn_end", forKey: .type)
            try container.encode(messageId, forKey: .messageId)
        case .error(let error):
            try container.encode("error", forKey: .type)
            try container.encode(error, forKey: .error)
        case .screenshot(let base64, let url):
            try container.encode("screenshot", forKey: .type)
            try container.encode(base64, forKey: .base64)
            try container.encodeIfPresent(url, forKey: .url)
        case .terminalOutput(let text):
            try container.encode("terminal_output", forKey: .type)
            try container.encode(text, forKey: .text)
        case .unknown(let type):
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
    /// Raw icon spec from the leader's `.shtml` (Lucide name, VFS path, inline
    /// `<svg>`, or `data:` URL). Optional — sprinkles without an icon fall back
    /// to the default sparkle. iOS sidebar rendering doesn't consume this yet.
    let icon: String?

    var id: String { name }
}

// MARK: - TrayTargetEntry / RemoteTargetInfo

/// Mirrors RemoteTargetInfo.capabilities from tray-sync-protocol.ts (Task 5).
/// `network` gates whether the leader may drive `Network.*` CDP against this
/// target; distinct from the host-page `openUrl` capability.
struct CherryCapabilities: Codable, Hashable {
    let navigate: Bool
    let network: Bool
    let screenshot: Bool
}

/// Mirrors RemoteTargetInfo from tray-sync-protocol.ts (sent in targets.advertise)
struct RemoteTargetInfo: Codable, Hashable {
    let targetId: String
    let title: String
    let url: String
    var kind: String?
    var capabilities: CherryCapabilities?
}

// MARK: - CDPTargetSummary

/// Lightweight description of a local CDP target (a hosted WKWebView). Used
/// by the iOS UI's tabs carousel; not part of the wire protocol.
struct CDPTargetSummary: Identifiable, Hashable {
    let id: String
    var title: String
    var url: String
}

/// Mirrors TrayTargetEntry from tray-sync-protocol.ts (received in targets.registry)
struct TrayTargetEntry: Codable, Hashable {
    let targetId: String
    let localTargetId: String
    let runtimeId: String
    let title: String
    let url: String
    let isLocal: Bool
    /// Distinguishes a real browser page from a cooperative cherry host page.
    var kind: String?
    /// Only present for `kind == "cherry"`: what the host page lends to the
    /// leader. Same shape as `RemoteTargetInfo.capabilities`.
    var capabilities: CherryCapabilities?
}

// MARK: - TrayChunkFrame

/// Mirrors `TrayChunkFrame` from tray-sync-protocol.ts.
///
/// A chunk frame is deliberately NOT a case of `LeaderToFollowerMessage`: it
/// belongs to the layer *below* the message union. A sender splits an oversize
/// serialized message into frames, and `AppState.handleDataChannelMessage`
/// reassembles them (via `TrayChunkReassembler`) before decoding the union at
/// all.
///
/// This is why it has no golden-corpus fixture and no `ios` decode
/// expectation: the corpus enumerates the message unions, and this is not in
/// them. It also means every leader→follower message type gains oversize
/// support at once, rather than one type at a time.
struct TrayChunkFrame: Codable {
    static let typeTag = "__chunk"

    let type: String
    let chunkId: String
    let chunkIndex: Int
    let totalChunks: Int
    let chunkData: String

    /// True when the frame's indices are self-consistent. Callers additionally
    /// bound `totalChunks` (see `TrayChunkLimits.maxChunkCount`) before
    /// allocating anything sized by it.
    var hasValidIndices: Bool {
        totalChunks > 0 && chunkIndex >= 0 && chunkIndex < totalChunks
    }
}

// MARK: - TraySyncCapabilities

/// Mirrors `TraySyncCapabilities`. Advertised on `hello` so the leader can
/// route capability-gated work.
struct TraySyncCapabilities: Codable, Equatable {
    /// This peer can run OS shell commands via `exec.request`.
    ///
    /// Always false here, stated rather than implied. iOS has no OS shell, and
    /// the leader gates remote exec on `peerCapabilities?.exec`
    /// (`remote-exec.ts`), so omitting the field produced the right behaviour
    /// by accident. Sending it makes the contract explicit, and a future
    /// capability added to this struct starts from a written-down baseline.
    let exec: Bool
}

/// What this build tells the leader it can do.
let trayFollowerCapabilities = TraySyncCapabilities(exec: false)

/// One-line self-description surfaced by the leader's `ssh --list`, mirroring
/// the `motd` the Go CLI sets. Identifies the phone among several followers.
var trayFollowerMotd: String {
    let device = UIDevice.current
    return "SLICC iOS follower on \(device.name) (\(device.systemName) \(device.systemVersion)) — chat and CDP targets, no shell"
}

// MARK: - LeaderToFollowerMessage

/// Mirrors a **subset** of `LeaderToFollowerMessage` from tray-sync-protocol.ts.
/// Implemented here: chat, scoops, sprinkles, control, leader-initiated CDP
/// (`cdp.request`, `targets.registry`, `tab.open`), the cherry host-page
/// event fan-out (`cherry.slicc_event`), and the `fs.*` pair. TS-only and
/// omitted from this enum: the leader→follower reply path for
/// follower-originated requests (`cdp.response`,
/// `cdp.event`, `tab.opened`, `tab.open.error`) — iOS never originates those
/// so it has no need to consume the reply. See
/// `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture" for the
/// canonical per-message matrix.
enum LeaderToFollowerMessage: Codable {
    case snapshot(messages: [ChatMessage], scoopJid: String)
    case snapshotChunk(chunkData: String, chunkIndex: Int, totalChunks: Int, scoopJid: String)
    case agentEvent(event: AgentEvent, scoopJid: String)
    case userMessageEcho(
        text: String, messageId: String, scoopJid: String, attachments: [MessageAttachment]?)
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
    case sprinkleReloaded(sprinkleName: String)
    // CDP / federated targets — leader → follower
    case cdpRequest(
        requestId: String,
        localTargetId: String,
        method: String,
        params: AnyCodable?,
        sessionId: String?)
    case targetsRegistry(targets: [TrayTargetEntry])
    case tabOpen(requestId: String, url: String)
    case previewOpen(requestId: String, url: String)
    case cherrySliccEvent(targetId: String, name: String, detail: AnyCodable?)
    /// Leader-originated fs request. iOS federates no filesystem, so
    /// `AppState` answers it with an error rather than dropping it — the
    /// leader sets no timeout, so silence hangs its promise.
    case fsRequest(requestId: String, request: TrayFsRequest)
    /// Reply to a follower-originated `fs.request`, chunked for large reads.
    case fsResponse(requestId: String, response: TrayFsResponse)
    /// Leader theme broadcast. iOS derives a native palette from `base` +
    /// `tokens` (raw `css` and per-component overrides are ignored — see
    /// `AppState.applyLeaderTheme`); `null` resets to the system scheme.
    case themeApply(themeJson: String?)
    /// Additive version handshake (`hello`) — both sides send it first.
    /// `capabilities` and `motd` are decoded for parity; nothing on iOS
    /// consumes them yet, but dropping them silently is the drift class that
    /// `theme.apply` already demonstrated.
    case hello(
        protocolVersion: Int, runtime: String?, capabilities: TraySyncCapabilities?, motd: String?)
    case ping
    case pong
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, messages, scoopJid, chunkData, chunkIndex, totalChunks
        case event, text, messageId, scoopStatus, error
        case scoops, activeScoopJid, sprinkles
        case requestId, sprinkleName, content, data, attachments
        case localTargetId, method, params, sessionId, targets, url
        case targetId, name, detail
        case themeJson, protocolVersion, runtime
        case request, response
        case capabilities, motd
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
                scoopJid: try container.decode(String.self, forKey: .scoopJid),
                attachments: try container.decodeIfPresent(
                    [MessageAttachment].self, forKey: .attachments))
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
        case "sprinkle.reloaded":
            self = .sprinkleReloaded(
                sprinkleName: try container.decode(String.self, forKey: .sprinkleName)
            )
        case "cdp.request":
            self = .cdpRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                localTargetId: try container.decode(String.self, forKey: .localTargetId),
                method: try container.decode(String.self, forKey: .method),
                params: try container.decodeIfPresent(AnyCodable.self, forKey: .params),
                sessionId: try container.decodeIfPresent(String.self, forKey: .sessionId)
            )
        case "targets.registry":
            self = .targetsRegistry(
                targets: (try? container.decode([TrayTargetEntry].self, forKey: .targets)) ?? []
            )
        case "tab.open":
            self = .tabOpen(
                requestId: try container.decode(String.self, forKey: .requestId),
                url: try container.decode(String.self, forKey: .url)
            )
        case "preview.open":
            self = .previewOpen(
                requestId: try container.decode(String.self, forKey: .requestId),
                url: try container.decode(String.self, forKey: .url)
            )
        case "cherry.slicc_event":
            self = .cherrySliccEvent(
                targetId: try container.decode(String.self, forKey: .targetId),
                name: try container.decode(String.self, forKey: .name),
                detail: try container.decodeIfPresent(AnyCodable.self, forKey: .detail))
        case "fs.request":
            self = .fsRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                request: try container.decode(TrayFsRequest.self, forKey: .request))
        case "fs.response":
            self = .fsResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                response: try container.decode(TrayFsResponse.self, forKey: .response))
        case "theme.apply":
            self = .themeApply(
                themeJson: try container.decodeIfPresent(String.self, forKey: .themeJson))
        // Transcript export response variants — iOS never requests exports;
        // decode these to `.unknown` so the tray session is not torn down.
        case "transcript.export.pending",
            "transcript.export.denied",
            "transcript.export.start",
            "transcript.export.chunk",
            "transcript.export.complete",
            "transcript.export.error",
            // Delegated approval prompt from a headless (cloud) leader. iOS
            // never originates an export, so it is never asked to approve one.
            "transcript.export.approve.request":
            self = .unknown(type: type)
        case "hello":
            self = .hello(
                protocolVersion: try container.decode(Int.self, forKey: .protocolVersion),
                runtime: try container.decodeIfPresent(String.self, forKey: .runtime),
                capabilities: try container.decodeIfPresent(
                    TraySyncCapabilities.self, forKey: .capabilities),
                motd: try container.decodeIfPresent(String.self, forKey: .motd))
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
        case .snapshot(let messages, let scoopJid):
            try container.encode("snapshot", forKey: .type)
            try container.encode(messages, forKey: .messages)
            try container.encode(scoopJid, forKey: .scoopJid)
        case .snapshotChunk(let chunkData, let chunkIndex, let totalChunks, let scoopJid):
            try container.encode("snapshot_chunk", forKey: .type)
            try container.encode(chunkData, forKey: .chunkData)
            try container.encode(chunkIndex, forKey: .chunkIndex)
            try container.encode(totalChunks, forKey: .totalChunks)
            try container.encode(scoopJid, forKey: .scoopJid)
        case .agentEvent(let event, let scoopJid):
            try container.encode("agent_event", forKey: .type)
            try container.encode(event, forKey: .event)
            try container.encode(scoopJid, forKey: .scoopJid)
        case .userMessageEcho(let text, let messageId, let scoopJid, let attachments):
            try container.encode("user_message_echo", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(scoopJid, forKey: .scoopJid)
            try container.encodeIfPresent(attachments, forKey: .attachments)
        case .status(let scoopStatus):
            try container.encode("status", forKey: .type)
            try container.encode(scoopStatus, forKey: .scoopStatus)
        case .error(let error):
            try container.encode("error", forKey: .type)
            try container.encode(error, forKey: .error)
        case .scoopsList(let scoops, let activeScoopJid):
            try container.encode("scoops.list", forKey: .type)
            try container.encode(scoops, forKey: .scoops)
            try container.encode(activeScoopJid, forKey: .activeScoopJid)
        case .sprinklesList(let sprinkles):
            try container.encode("sprinkles.list", forKey: .type)
            try container.encode(sprinkles, forKey: .sprinkles)
        case .sprinkleContent(let requestId, let sprinkleName, let content, let chunkIndex, let totalChunks, let error):
            try container.encode("sprinkle.content", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encode(content, forKey: .content)
            try container.encodeIfPresent(chunkIndex, forKey: .chunkIndex)
            try container.encodeIfPresent(totalChunks, forKey: .totalChunks)
            try container.encodeIfPresent(error, forKey: .error)
        case .sprinkleUpdate(let sprinkleName, let data):
            try container.encode("sprinkle.update", forKey: .type)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encodeIfPresent(data, forKey: .data)
        case .sprinkleReloaded(let sprinkleName):
            try container.encode("sprinkle.reloaded", forKey: .type)
            try container.encode(sprinkleName, forKey: .sprinkleName)
        case .cdpRequest(let requestId, let localTargetId, let method, let params, let sessionId):
            try container.encode("cdp.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(localTargetId, forKey: .localTargetId)
            try container.encode(method, forKey: .method)
            try container.encodeIfPresent(params, forKey: .params)
            try container.encodeIfPresent(sessionId, forKey: .sessionId)
        case .targetsRegistry(let targets):
            try container.encode("targets.registry", forKey: .type)
            try container.encode(targets, forKey: .targets)
        case .tabOpen(let requestId, let url):
            try container.encode("tab.open", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(url, forKey: .url)
        case .previewOpen(let requestId, let url):
            try container.encode("preview.open", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(url, forKey: .url)
        case .cherrySliccEvent(let targetId, let name, let detail):
            try container.encode("cherry.slicc_event", forKey: .type)
            try container.encode(targetId, forKey: .targetId)
            try container.encode(name, forKey: .name)
            try container.encodeIfPresent(detail, forKey: .detail)
        case .fsRequest(let requestId, let request):
            try container.encode("fs.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(request, forKey: .request)
        case .fsResponse(let requestId, let response):
            try container.encode("fs.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(response, forKey: .response)
        case .themeApply(let themeJson):
            try container.encode("theme.apply", forKey: .type)
            try container.encodeIfPresent(themeJson, forKey: .themeJson)
        case .hello(let protocolVersion, let runtime, let capabilities, let motd):
            try container.encode("hello", forKey: .type)
            try container.encode(protocolVersion, forKey: .protocolVersion)
            try container.encodeIfPresent(runtime, forKey: .runtime)
            try container.encodeIfPresent(capabilities, forKey: .capabilities)
            try container.encodeIfPresent(motd, forKey: .motd)
        case .ping:
            try container.encode("ping", forKey: .type)
        case .pong:
            try container.encode("pong", forKey: .type)
        case .unknown(let type):
            try container.encode(type, forKey: .type)
        }
    }
}

// MARK: - FollowerToLeaderMessage

/// Mirrors a **subset** of `FollowerToLeaderMessage` from tray-sync-protocol.ts.
/// Implemented here: chat, scoops/sprinkles, targets advertise, CDP/tab.open
/// reply path back to the leader (`cdp.response`, `cdp.event`, `tab.opened`,
/// `tab.openError`), and the `fs.*` pair — iOS originates `fs.request` against
/// the leader's VFS and answers a leader-originated one with an error.
/// TS-only and omitted: follower-originated `cdp.request`/`tab.open` (iOS only
/// responds to leader-initiated requests, never originates). The `tab.openError` case is
/// declared for protocol symmetry but `CDPBridge.handleTabOpen` always sends
/// `.tabOpened` synchronously after the navigation kickoff — there is no
/// runtime path that emits `tab.openError`. See `docs/architecture.md`
/// "Multi-Browser Sync (Tray) Architecture" for the canonical matrix.
enum FollowerToLeaderMessage: Codable {
    /// `steer` interrupts the leader's running turn instead of queueing
    /// behind it (`user_message.steer`, optional on the wire — omitted when
    /// false, mirroring the browser follower). `attachments` inlines
    /// downscaled photos as base64 (`data`) — a follower has no leader-side
    /// writer, so there is never a `path` variant from this side.
    case userMessage(
        text: String, messageId: String, steer: Bool = false,
        attachments: [MessageAttachment]? = nil)
    /// Start a new chat with one of three dispositions (`new_session`):
    /// save (enriched freeze), skip (quick freeze), erase (discard).
    case newSession(action: NewSessionAction)
    case abort
    case requestSnapshot(scoopJid: String?)
    case scoopsSelect(scoopJid: String)
    case sprinklesRefresh
    case sprinkleFetch(requestId: String, sprinkleName: String)
    case sprinkleLick(sprinkleName: String, body: AnyCodable?, targetScoop: String?)
    // CDP / federated targets — follower → leader
    case targetsAdvertise(targets: [RemoteTargetInfo], runtimeId: String)
    case cdpResponse(
        requestId: String,
        result: AnyCodable?,
        error: String?,
        chunkData: String?,
        chunkIndex: Int?,
        totalChunks: Int?)
    case cdpEvent(method: String, params: AnyCodable, sessionId: String?)
    case tabOpened(requestId: String, targetId: String)
    case tabOpenError(requestId: String, error: String)
    /// Ask the leader to run an fs op. `targetRuntimeId: "leader"` routes it to
    /// the leader's own VFS; any other value forwards it to a peer follower.
    case fsRequest(requestId: String, targetRuntimeId: String, request: TrayFsRequest)
    /// Answer to a leader-originated `fs.request`.
    case fsResponse(requestId: String, response: TrayFsResponse)
    /// Generic lick envelope. The leader accepts only the types in
    /// `FORWARDABLE_TO_LEADER` (`navigate`, `discovery`) and rejects the rest,
    /// so `FollowerLickType` is narrowed to match. `sprinkle.lick` stays on its
    /// own message: `sprinkle` is NOT forwardable, and routing it through here
    /// would get it dropped with a warning.
    case lick(event: LickEvent)
    /// Additive version handshake (`hello`) — iOS sends it first on channel open.
    case hello(
        protocolVersion: Int, runtime: String?, capabilities: TraySyncCapabilities?, motd: String?)
    case ping
    case pong

    private enum CodingKeys: String, CodingKey {
        case type, text, messageId, scoopJid, action, steer, attachments
        case event, capabilities, motd
        case requestId, sprinkleName, body, targetScoop
        case targets, runtimeId, result, error, chunkData, chunkIndex, totalChunks
        case method, params, sessionId, targetId, url
        case protocolVersion, runtime
        case targetRuntimeId, request, response
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user_message":
            self = .userMessage(
                text: try container.decode(String.self, forKey: .text),
                messageId: try container.decode(String.self, forKey: .messageId),
                steer: try container.decodeIfPresent(Bool.self, forKey: .steer) ?? false,
                attachments: try container.decodeIfPresent(
                    [MessageAttachment].self, forKey: .attachments))
        case "new_session":
            self = .newSession(
                action: try container.decode(NewSessionAction.self, forKey: .action))
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
        case "targets.advertise":
            self = .targetsAdvertise(
                targets: (try? container.decode([RemoteTargetInfo].self, forKey: .targets)) ?? [],
                runtimeId: try container.decode(String.self, forKey: .runtimeId))
        case "cdp.response":
            self = .cdpResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                result: try container.decodeIfPresent(AnyCodable.self, forKey: .result),
                error: try container.decodeIfPresent(String.self, forKey: .error),
                chunkData: try container.decodeIfPresent(String.self, forKey: .chunkData),
                chunkIndex: try container.decodeIfPresent(Int.self, forKey: .chunkIndex),
                totalChunks: try container.decodeIfPresent(Int.self, forKey: .totalChunks))
        case "cdp.event":
            self = .cdpEvent(
                method: try container.decode(String.self, forKey: .method),
                params: try container.decode(AnyCodable.self, forKey: .params),
                sessionId: try container.decodeIfPresent(String.self, forKey: .sessionId))
        case "tab.opened":
            self = .tabOpened(
                requestId: try container.decode(String.self, forKey: .requestId),
                targetId: try container.decode(String.self, forKey: .targetId))
        case "tab.open.error":
            self = .tabOpenError(
                requestId: try container.decode(String.self, forKey: .requestId),
                error: try container.decode(String.self, forKey: .error))
        case "fs.request":
            self = .fsRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                targetRuntimeId: try container.decode(String.self, forKey: .targetRuntimeId),
                request: try container.decode(TrayFsRequest.self, forKey: .request))
        case "fs.response":
            self = .fsResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                response: try container.decode(TrayFsResponse.self, forKey: .response))
        case "lick":
            self = .lick(event: try container.decode(LickEvent.self, forKey: .event))
        case "hello":
            self = .hello(
                protocolVersion: try container.decode(Int.self, forKey: .protocolVersion),
                runtime: try container.decodeIfPresent(String.self, forKey: .runtime),
                capabilities: try container.decodeIfPresent(
                    TraySyncCapabilities.self, forKey: .capabilities),
                motd: try container.decodeIfPresent(String.self, forKey: .motd))
        case "ping":
            self = .ping
        case "pong":
            self = .pong
        default:
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown FollowerToLeaderMessage type: \(type)"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .userMessage(let text, let messageId, let steer, let attachments):
            try container.encode("user_message", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode(messageId, forKey: .messageId)
            // Optional on the wire: omit rather than sending `false`/empty.
            if steer { try container.encode(true, forKey: .steer) }
            if let attachments, !attachments.isEmpty {
                try container.encode(attachments, forKey: .attachments)
            }
        case .newSession(let action):
            try container.encode("new_session", forKey: .type)
            try container.encode(action, forKey: .action)
        case .abort:
            try container.encode("abort", forKey: .type)
        case .requestSnapshot(let scoopJid):
            try container.encode("request_snapshot", forKey: .type)
            try container.encodeIfPresent(scoopJid, forKey: .scoopJid)
        case .scoopsSelect(let scoopJid):
            try container.encode("scoops.select", forKey: .type)
            try container.encode(scoopJid, forKey: .scoopJid)
        case .sprinklesRefresh:
            try container.encode("sprinkles.refresh", forKey: .type)
        case .sprinkleFetch(let requestId, let sprinkleName):
            try container.encode("sprinkle.fetch", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(sprinkleName, forKey: .sprinkleName)
        case .sprinkleLick(let sprinkleName, let body, let targetScoop):
            try container.encode("sprinkle.lick", forKey: .type)
            try container.encode(sprinkleName, forKey: .sprinkleName)
            try container.encodeIfPresent(body, forKey: .body)
            try container.encodeIfPresent(targetScoop, forKey: .targetScoop)
        case .targetsAdvertise(let targets, let runtimeId):
            try container.encode("targets.advertise", forKey: .type)
            try container.encode(targets, forKey: .targets)
            try container.encode(runtimeId, forKey: .runtimeId)
        case .cdpResponse(let requestId, let result, let error, let chunkData, let chunkIndex, let totalChunks):
            try container.encode("cdp.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(error, forKey: .error)
            try container.encodeIfPresent(chunkData, forKey: .chunkData)
            try container.encodeIfPresent(chunkIndex, forKey: .chunkIndex)
            try container.encodeIfPresent(totalChunks, forKey: .totalChunks)
        case .cdpEvent(let method, let params, let sessionId):
            try container.encode("cdp.event", forKey: .type)
            try container.encode(method, forKey: .method)
            try container.encode(params, forKey: .params)
            try container.encodeIfPresent(sessionId, forKey: .sessionId)
        case .tabOpened(let requestId, let targetId):
            try container.encode("tab.opened", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(targetId, forKey: .targetId)
        case .tabOpenError(let requestId, let error):
            try container.encode("tab.open.error", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(error, forKey: .error)
        case .fsRequest(let requestId, let targetRuntimeId, let request):
            try container.encode("fs.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(targetRuntimeId, forKey: .targetRuntimeId)
            try container.encode(request, forKey: .request)
        case .fsResponse(let requestId, let response):
            try container.encode("fs.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(response, forKey: .response)
        case .lick(let event):
            try container.encode("lick", forKey: .type)
            try container.encode(event, forKey: .event)
        case .hello(let protocolVersion, let runtime, let capabilities, let motd):
            try container.encode("hello", forKey: .type)
            try container.encode(protocolVersion, forKey: .protocolVersion)
            try container.encodeIfPresent(runtime, forKey: .runtime)
            try container.encodeIfPresent(capabilities, forKey: .capabilities)
            try container.encodeIfPresent(motd, forKey: .motd)
        case .ping:
            try container.encode("ping", forKey: .type)
        case .pong:
            try container.encode("pong", forKey: .type)
        }
    }
}
