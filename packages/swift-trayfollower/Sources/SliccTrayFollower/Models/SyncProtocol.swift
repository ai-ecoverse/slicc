import Foundation

/// The three `new_session` dispositions, mirroring
/// `packages/shared-ts/src/tray-sync-protocol.ts`.
public enum NewSessionAction: String, Codable {
    case save, skip, erase
}

/// Mirrors `TRAY_SYNC_PROTOCOL_VERSION` from
/// packages/shared-ts/src/tray-sync-protocol.ts. Exchanged
/// via the additive `hello` message both sides send on channel open.
public let traySyncProtocolVersion = 7

// MARK: - AgentEvent

/// Mirrors AgentEvent from packages/shared-ts/src/agent-wire-types.ts
public enum AgentEvent: Codable {
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

    public init(from decoder: Decoder) throws {
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

    public func encode(to encoder: Encoder) throws {
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
public struct ScoopSummary: Codable, Identifiable, Hashable {
    public let jid: String
    public let name: String
    public let folder: String
    public let isCone: Bool
    /// Ownership edge of the work-unit tree (#1666): `nil` for a cone (root) or
    /// when the leader predates the field; the owning unit's jid for a scoop.
    /// `isCone` stays the root test for rendering — this field only attributes
    /// a scoop to its cone, and is never used to promote a scoop to a root.
    public let parentId: String?
    public let assistantLabel: String
    public let trigger: String?
    /// Agent-tab lifecycle state. Optional for compatibility with older leaders.
    /// Deliberately a CLOSED four-value vocabulary — refinements ride
    /// `activity`, so adding detail never changes how an older follower renders
    /// this field.
    public let state: String?
    /// Optional refinement of `state` (`thinking` / `tool` / `awaiting`) —
    /// absent from older leaders, ignored by older followers. A value this
    /// build does not recognise must fall back to `state` alone.
    public let activity: String?
    /// Context-window fullness on the browser agent tabs' 0...100 scale.
    public let fill: Double?

    public var id: String { jid }

    /// Explicit public memberwise init — the synthesized one is internal once
    /// this type lives in `SliccTrayKit` and is constructed from the app/tests.
    public init(
        jid: String,
        name: String,
        folder: String,
        isCone: Bool,
        assistantLabel: String,
        trigger: String? = nil,
        state: String? = nil,
        activity: String? = nil,
        fill: Double? = nil,
        parentId: String? = nil
    ) {
        self.jid = jid
        self.name = name
        self.folder = folder
        self.isCone = isCone
        self.parentId = parentId
        self.assistantLabel = assistantLabel
        self.trigger = trigger
        self.state = state
        self.activity = activity
        self.fill = fill
    }
}

/// Mirrors SprinkleSummary from tray-sync-protocol.ts
public struct SprinkleSummary: Codable, Identifiable, Hashable {
    public let name: String
    public let title: String
    public let path: String
    public let open: Bool
    public let autoOpen: Bool
    /// Raw icon spec from the leader's `.shtml` (Lucide name, VFS path, inline
    /// `<svg>`, or `data:` URL). Optional — sprinkles without an icon fall back
    /// to the default sparkle. iOS sidebar rendering doesn't consume this yet.
    public let icon: String?

    public var id: String { name }

    public init(
        name: String,
        title: String,
        path: String,
        open: Bool,
        autoOpen: Bool = false,
        icon: String? = nil
    ) {
        self.name = name
        self.title = title
        self.path = path
        self.open = open
        self.autoOpen = autoOpen
        self.icon = icon
    }
}

// MARK: - Model Catalog / Selection

/// Thinking levels accepted by the leader's per-scoop configuration. The UI's
/// `max` choice is represented on the wire as `.xhigh` plus
/// `effortOverride: "max"`, matching the browser follower.
public enum TrayThinkingLevel: String, Codable, CaseIterable {
    case off, minimal, low, medium, high, xhigh
}

/// Credential-free model metadata advertised by the leader. Provider account
/// identity, keys, and tokens are deliberately absent from this wire shape.
public struct TrayModelCatalogEntry: Codable, Identifiable, Hashable {
    public let providerName: String
    public let modelId: String
    public let modelName: String
    public let reasoning: Bool

    public var id: String { modelId }

    public init(providerName: String, modelId: String, modelName: String, reasoning: Bool) {
        self.providerName = providerName
        self.modelId = modelId
        self.modelName = modelName
        self.reasoning = reasoning
    }
}

/// The global model selection plus thinking configuration for one scoop.
public struct TrayModelSelectionState: Codable, Equatable {
    public let activeModelId: String
    public let scoopJid: String
    public let thinkingLevel: TrayThinkingLevel?
    public let effortOverride: String?

    public init(
        activeModelId: String,
        scoopJid: String,
        thinkingLevel: TrayThinkingLevel?,
        effortOverride: String?
    ) {
        self.activeModelId = activeModelId
        self.scoopJid = scoopJid
        self.thinkingLevel = thinkingLevel
        self.effortOverride = effortOverride
    }
}

// MARK: - TrayTargetEntry / RemoteTargetInfo

/// Mirrors RemoteTargetInfo.capabilities from tray-sync-protocol.ts (Task 5).
/// `network` gates whether the leader may drive `Network.*` CDP against this
/// target; distinct from the host-page `openUrl` capability.
public struct CherryCapabilities: Codable, Hashable {
    public let navigate: Bool
    public let network: Bool
    public let screenshot: Bool

    public init(navigate: Bool, network: Bool, screenshot: Bool) {
        self.navigate = navigate
        self.network = network
        self.screenshot = screenshot
    }
}

/// Mirrors RemoteTargetInfo from tray-sync-protocol.ts (sent in targets.advertise)
public struct RemoteTargetInfo: Codable, Hashable {
    public let targetId: String
    public let title: String
    public let url: String
    public var kind: String?
    public var capabilities: CherryCapabilities?

    public init(
        targetId: String,
        title: String,
        url: String,
        kind: String? = nil,
        capabilities: CherryCapabilities? = nil
    ) {
        self.targetId = targetId
        self.title = title
        self.url = url
        self.kind = kind
        self.capabilities = capabilities
    }
}

// MARK: - CDPTargetSummary

/// Lightweight description of a local CDP target (a hosted WKWebView). Used
/// by the iOS UI's tabs carousel; not part of the wire protocol.
public struct CDPTargetSummary: Identifiable, Hashable {
    public let id: String
    public var title: String
    public var url: String

    public init(id: String, title: String, url: String) {
        self.id = id
        self.title = title
        self.url = url
    }
}

/// Mirrors TrayTargetEntry from tray-sync-protocol.ts (received in targets.registry)
public struct TrayTargetEntry: Codable, Hashable {
    public let targetId: String
    public let localTargetId: String
    public let runtimeId: String
    public let title: String
    public let url: String
    public let isLocal: Bool
    /// Distinguishes a real browser page from a cooperative cherry host page.
    public var kind: String?
    /// Only present for `kind == "cherry"`: what the host page lends to the
    /// leader. Same shape as `RemoteTargetInfo.capabilities`.
    public var capabilities: CherryCapabilities?

    public init(
        targetId: String,
        localTargetId: String,
        runtimeId: String,
        title: String,
        url: String,
        isLocal: Bool,
        kind: String? = nil,
        capabilities: CherryCapabilities? = nil
    ) {
        self.targetId = targetId
        self.localTargetId = localTargetId
        self.runtimeId = runtimeId
        self.title = title
        self.url = url
        self.isLocal = isLocal
        self.kind = kind
        self.capabilities = capabilities
    }
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
public struct TrayChunkFrame: Codable {
    public static let typeTag = "__chunk"

    public let type: String
    let chunkId: String
    public let chunkIndex: Int
    public let totalChunks: Int
    public let chunkData: String

    public init(
        type: String, chunkId: String, chunkIndex: Int, totalChunks: Int, chunkData: String
    ) {
        self.type = type
        self.chunkId = chunkId
        self.chunkIndex = chunkIndex
        self.totalChunks = totalChunks
        self.chunkData = chunkData
    }

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
public struct TraySyncCapabilities: Codable, Equatable {
    /// This peer accepts `exec.request`. iOS supports a restricted verb set and
    /// never interprets the command with a shell.
    public let exec: Bool

    /// This peer hosts CDP-driveable browser targets and accepts `tab.open`.
    /// iOS does, through its WKWebView-backed `CDPBridge`.
    public let browser: Bool?

    /// This peer can host an interactive OAuth popup (window + permissions
    /// surface + human). iOS has no popup model, so it never claims this and
    /// a leader will not delegate a login here.
    public let oauthPopup: Bool?

    /// This peer renders delegated sudo prompts (`sudo.approve.request`) to a
    /// human and answers with `sudo.approve.response` (v7, #2062). iOS does.
    public let sudoApproval: Bool?

    /// Allow / Always on this peer sit behind device-owner authentication
    /// (Face ID / Touch ID / passcode). Only such a peer may answer `always`;
    /// the leader downgrades anyone else's to a one-shot allow. iOS claims it
    /// when `LAContext` reports `.deviceOwnerAuthentication` available.
    public let biometric: Bool?

    public init(
        exec: Bool,
        browser: Bool? = nil,
        oauthPopup: Bool? = nil,
        sudoApproval: Bool? = nil,
        biometric: Bool? = nil
    ) {
        self.exec = exec
        self.browser = browser
        self.oauthPopup = oauthPopup
        self.sudoApproval = sudoApproval
        self.biometric = biometric
    }
}

/// What this build tells the leader it can do. `biometric` is decided at
/// connect time from the device's authentication policy — see
/// `makeTrayFollowerCapabilities(deviceOwnerAuth:)`.
public let trayFollowerCapabilities = makeTrayFollowerCapabilities(deviceOwnerAuth: false)

/// Capability advertisement for a follower whose device can (or cannot)
/// authenticate its owner. `sudoApproval` is always on: the card renders
/// either way, and a device with no passcode still gets Allow / Deny — the
/// leader just refuses its `always`.
public func makeTrayFollowerCapabilities(deviceOwnerAuth: Bool) -> TraySyncCapabilities {
    TraySyncCapabilities(
        exec: true, browser: true, sudoApproval: true, biometric: deviceOwnerAuth ? true : nil)
}

// MARK: - LeaderToFollowerMessage

/// Mirrors a **subset** of `LeaderToFollowerMessage` from tray-sync-protocol.ts.
/// Implemented here: chat, scoops, model/thinking selection, sprinkles,
/// control, leader-initiated CDP
/// (`cdp.request`, `targets.registry`, `tab.open`), the cherry host-page
/// event fan-out (`cherry.slicc_event`), the `fs.*` pair, and all four `exec.*`
/// wire variants. TS-only and
/// omitted from this enum: the leader→follower reply path for
/// follower-originated requests (`cdp.response`,
/// `cdp.event`, `tab.opened`, `tab.open.error`) — iOS never originates those
/// so it has no need to consume the reply. See
/// `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture" for the
/// canonical per-message matrix.
public enum LeaderToFollowerMessage: Codable {
    case snapshot(messages: [ChatMessage], scoopJid: String)
    case snapshotChunk(chunkData: String, chunkIndex: Int, totalChunks: Int, scoopJid: String)
    case agentEvent(event: AgentEvent, scoopJid: String)
    case userMessageEcho(
        text: String, messageId: String, scoopJid: String, attachments: [MessageAttachment]?)
    case status(scoopStatus: String, scoopJid: String? = nil)
    case error(error: String)
    case scoopsList(scoops: [ScoopSummary], activeScoopJid: String)
    case modelsList(models: [TrayModelCatalogEntry])
    case modelState(state: TrayModelSelectionState)
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
    /// Answer to a FOLLOWER-originated `cdp.request` (tab previews drive
    /// leader tabs via CDP). Large results arrive chunked: `chunkData`
    /// slices of the serialized result JSON, reassembled by requestId.
    case cdpResponse(
        requestId: String,
        result: AnyCodable?,
        error: String?,
        chunkData: String?,
        chunkIndex: Int?,
        totalChunks: Int?)
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
    case execRequest(requestId: String, command: String, cwd: String?, env: [String: String]?)
    case execChunk(requestId: String, stream: String, data: String)
    case execResponse(requestId: String, exitCode: Int, signal: String?, error: String?)
    case execSignal(requestId: String, signal: String)
    /// Leader theme broadcast. iOS derives a native palette from `base` +
    /// `tokens` (raw `css` and per-component overrides are ignored — see
    /// `AppState.applyLeaderTheme`); `null` resets to the system scheme.
    case themeApply(themeJson: String?)
    /// Delegated sudo prompt (v7, #2062): the leader wants this phone's human
    /// to approve a gated action. `expiresAt` is epoch milliseconds.
    case sudoApproveRequest(
        requestId: String,
        kind: String,
        detail: String,
        suggestedPattern: String?,
        scoopName: String?,
        expiresAt: Double)
    /// The leader withdrew a `sudo.approve.request` (answered elsewhere / timed out).
    case sudoApproveCancel(requestId: String)
    /// Additive version handshake (`hello`) — both sides send it first.
    /// `capabilities` gates leader-backed surfaces such as Terminal; `motd` is
    /// retained for protocol parity.
    case hello(
        protocolVersion: Int, runtime: String?, capabilities: TraySyncCapabilities?, motd: String?)
    case ping
    case pong
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, messages, scoopJid, chunkData, chunkIndex, totalChunks
        case event, text, messageId, scoopStatus, error, result
        case scoops, activeScoopJid, models, state, sprinkles
        case requestId, sprinkleName, content, data, attachments
        case localTargetId, method, params, sessionId, targets, url
        case targetId, name, detail
        case themeJson, protocolVersion, runtime
        case request, response
        case capabilities, motd
        case command, cwd, env, stream, exitCode, signal
        case kind, suggestedPattern, scoopName, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        if let remoteOperation = try Self.decodeRemoteOperation(type: type, from: container) {
            self = remoteOperation
            return
        }
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
            self = .status(
                scoopStatus: try container.decode(String.self, forKey: .scoopStatus),
                scoopJid: try container.decodeIfPresent(String.self, forKey: .scoopJid))
        case "error":
            self = .error(error: try container.decode(String.self, forKey: .error))
        case "scoops.list":
            self = .scoopsList(
                scoops: (try? container.decode([ScoopSummary].self, forKey: .scoops)) ?? [],
                activeScoopJid: (try? container.decode(String.self, forKey: .activeScoopJid)) ?? ""
            )
        case "models.list":
            self = .modelsList(
                models: try container.decode([TrayModelCatalogEntry].self, forKey: .models))
        case "model.state":
            self = .modelState(
                state: try container.decode(TrayModelSelectionState.self, forKey: .state))
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
        case "cdp.response":
            self = .cdpResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                result: try container.decodeIfPresent(AnyCodable.self, forKey: .result),
                error: try container.decodeIfPresent(String.self, forKey: .error),
                chunkData: try container.decodeIfPresent(String.self, forKey: .chunkData),
                chunkIndex: try container.decodeIfPresent(Int.self, forKey: .chunkIndex),
                totalChunks: try container.decodeIfPresent(Int.self, forKey: .totalChunks))
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
            "transcript.export.error":
            self = .unknown(type: type)
        case "sudo.approve.request":
            self = .sudoApproveRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                kind: try container.decode(String.self, forKey: .kind),
                detail: try container.decode(String.self, forKey: .detail),
                suggestedPattern: try container.decodeIfPresent(
                    String.self, forKey: .suggestedPattern),
                scoopName: try container.decodeIfPresent(String.self, forKey: .scoopName),
                expiresAt: try container.decode(Double.self, forKey: .expiresAt))
        case "sudo.approve.cancel":
            self = .sudoApproveCancel(
                requestId: try container.decode(String.self, forKey: .requestId))
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

    private static func decodeRemoteOperation(
        type: String, from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> Self? {
        switch type {
        case "fs.request":
            return .fsRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                request: try container.decode(TrayFsRequest.self, forKey: .request))
        case "fs.response":
            return .fsResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                response: try container.decode(TrayFsResponse.self, forKey: .response))
        case "exec.request":
            return .execRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                command: try container.decode(String.self, forKey: .command),
                cwd: try container.decodeIfPresent(String.self, forKey: .cwd),
                env: try container.decodeIfPresent([String: String].self, forKey: .env))
        case "exec.chunk":
            return .execChunk(
                requestId: try container.decode(String.self, forKey: .requestId),
                stream: try container.decode(String.self, forKey: .stream),
                data: try container.decode(String.self, forKey: .data))
        case "exec.response":
            return .execResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                exitCode: try container.decode(Int.self, forKey: .exitCode),
                signal: try container.decodeIfPresent(String.self, forKey: .signal),
                error: try container.decodeIfPresent(String.self, forKey: .error))
        case "exec.signal":
            return .execSignal(
                requestId: try container.decode(String.self, forKey: .requestId),
                signal: try container.decode(String.self, forKey: .signal))
        default:
            return nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if try encodeRemoteOperation(to: &container) { return }
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
        case .status(let scoopStatus, let scoopJid):
            try container.encode("status", forKey: .type)
            try container.encode(scoopStatus, forKey: .scoopStatus)
            try container.encodeIfPresent(scoopJid, forKey: .scoopJid)
        case .error(let error):
            try container.encode("error", forKey: .type)
            try container.encode(error, forKey: .error)
        case .scoopsList(let scoops, let activeScoopJid):
            try container.encode("scoops.list", forKey: .type)
            try container.encode(scoops, forKey: .scoops)
            try container.encode(activeScoopJid, forKey: .activeScoopJid)
        case .modelsList(let models):
            try container.encode("models.list", forKey: .type)
            try container.encode(models, forKey: .models)
        case .modelState(let state):
            try container.encode("model.state", forKey: .type)
            try container.encode(state, forKey: .state)
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
        case .cdpResponse(
            let requestId, let result, let error, let chunkData, let chunkIndex,
            let totalChunks):
            try container.encode("cdp.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(error, forKey: .error)
            try container.encodeIfPresent(chunkData, forKey: .chunkData)
            try container.encodeIfPresent(chunkIndex, forKey: .chunkIndex)
            try container.encodeIfPresent(totalChunks, forKey: .totalChunks)
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
        case .fsRequest, .fsResponse, .execRequest, .execChunk, .execResponse, .execSignal:
            return
        case .themeApply(let themeJson):
            try container.encode("theme.apply", forKey: .type)
            try container.encodeIfPresent(themeJson, forKey: .themeJson)
        case .sudoApproveRequest(
            let requestId, let kind, let detail, let suggestedPattern, let scoopName, let expiresAt):
            try container.encode("sudo.approve.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(kind, forKey: .kind)
            try container.encode(detail, forKey: .detail)
            try container.encodeIfPresent(suggestedPattern, forKey: .suggestedPattern)
            try container.encodeIfPresent(scoopName, forKey: .scoopName)
            try container.encode(expiresAt, forKey: .expiresAt)
        case .sudoApproveCancel(let requestId):
            try container.encode("sudo.approve.cancel", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
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

    private func encodeRemoteOperation(
        to container: inout KeyedEncodingContainer<CodingKeys>
    ) throws -> Bool {
        switch self {
        case .fsRequest(let requestId, let request):
            try container.encode("fs.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(request, forKey: .request)
        case .fsResponse(let requestId, let response):
            try container.encode("fs.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(response, forKey: .response)
        case .execRequest(let requestId, let command, let cwd, let env):
            try container.encode("exec.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(command, forKey: .command)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(env, forKey: .env)
        case .execChunk(let requestId, let stream, let data):
            try container.encode("exec.chunk", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(stream, forKey: .stream)
            try container.encode(data, forKey: .data)
        case .execResponse(let requestId, let exitCode, let signal, let error):
            try container.encode("exec.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(signal, forKey: .signal)
            try container.encodeIfPresent(error, forKey: .error)
        case .execSignal(let requestId, let signal):
            try container.encode("exec.signal", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(signal, forKey: .signal)
        default:
            return false
        }
        return true
    }
}

// MARK: - FollowerToLeaderMessage

/// Mirrors a **subset** of `FollowerToLeaderMessage` from tray-sync-protocol.ts.
/// Implemented here: chat, scoops, model/thinking selection, sprinkles,
/// targets advertise, CDP/tab.open
/// reply path back to the leader (`cdp.response`, `cdp.event`, `tab.opened`,
/// `tab.openError`), and the `fs.*` pair — iOS originates `fs.request` against
/// the leader's VFS and answers a leader-originated one with an error, plus all
/// four `exec.*` wire variants for the leader-backed terminal.
/// TS-only and omitted: follower-originated `cdp.request`/`tab.open` (iOS only
/// responds to leader-initiated requests, never originates). The `tab.openError` case is
/// declared for protocol symmetry but `CDPBridge.handleTabOpen` always sends
/// `.tabOpened` synchronously after the navigation kickoff — there is no
/// runtime path that emits `tab.openError`. See `docs/architecture.md`
/// "Multi-Browser Sync (Tray) Architecture" for the canonical matrix.
public enum FollowerToLeaderMessage: Codable {
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
    case modelsRequest
    case modelSelect(modelId: String)
    case thinkingSet(
        scoopJid: String, thinkingLevel: TrayThinkingLevel, effortOverride: String?)
    case sprinklesRefresh
    case sprinkleFetch(requestId: String, sprinkleName: String)
    case sprinkleLick(sprinkleName: String, body: AnyCodable?, targetScoop: String?)
    // CDP / federated targets — follower → leader
    case targetsAdvertise(targets: [RemoteTargetInfo], runtimeId: String)
    /// Follower-originated CDP against a federated target.
    /// `targetRuntimeId: "leader"` runs on the leader's own browser
    /// transport (tab previews use Target.attachToTarget +
    /// Page.captureScreenshot); other values forward to that follower.
    case cdpRequest(
        requestId: String,
        targetRuntimeId: String,
        localTargetId: String,
        method: String,
        params: AnyCodable?,
        sessionId: String?)
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
    /// "Teleport that tab to me": ask the leader to open a copy of a tray
    /// target HERE, carrying its cookies + web storage. The destination is
    /// implicit — the leader derives it from this channel — so there is no
    /// runtime id in the payload. The reply arrives on `tab.opened` /
    /// `tab.open.error`, keyed by `requestId`.
    case tabTeleportRequest(requestId: String, targetId: String)
    /// Ask the leader to run an fs op. `targetRuntimeId: "leader"` routes it to
    /// the leader's own VFS; any other value forwards it to a peer follower.
    case fsRequest(requestId: String, targetRuntimeId: String, request: TrayFsRequest)
    /// Answer to a leader-originated `fs.request`.
    case fsResponse(requestId: String, response: TrayFsResponse)
    case execRequest(requestId: String, command: String, cwd: String?, env: [String: String]?)
    case execChunk(requestId: String, stream: String, data: String)
    case execResponse(requestId: String, exitCode: Int, signal: String?, error: String?)
    case execSignal(requestId: String, signal: String)
    /// Generic lick envelope. The leader accepts only the types in
    /// `FORWARDABLE_TO_LEADER` (`navigate`, `discovery`) and rejects the rest,
    /// so `FollowerLickType` is narrowed to match. `sprinkle.lick` stays on its
    /// own message: `sprinkle` is NOT forwardable, and routing it through here
    /// would get it dropped with a warning.
    case lick(event: LickEvent)
    /// Verdict for a delegated `sudo.approve.request` (v7, #2062). `pattern`
    /// only with `always`; `attestation` names the gate the human passed
    /// (`biometric` / `passcode` / `none`).
    case sudoApproveResponse(
        requestId: String, decision: String, pattern: String?, attestation: String?)
    /// Register this device's APNs token so the hub can wake it (v7, #2062).
    case pushRegister(platform: String, token: String, environment: String)
    /// Additive version handshake (`hello`) — iOS sends it first on channel open.
    case hello(
        protocolVersion: Int, runtime: String?, capabilities: TraySyncCapabilities?, motd: String?)
    case ping
    case pong

    private enum CodingKeys: String, CodingKey {
        case type, text, messageId, scoopJid, action, steer, attachments
        case modelId, thinkingLevel, effortOverride
        case event, capabilities, motd
        case requestId, sprinkleName, body, targetScoop
        case targets, runtimeId, result, error, chunkData, chunkIndex, totalChunks
        case method, params, sessionId, targetId, url
        case protocolVersion, runtime
        case targetRuntimeId, localTargetId, request, response
        case command, cwd, env, stream, data, exitCode, signal
        case decision, pattern, attestation, platform, token, environment
    }

    public init(from decoder: Decoder) throws {
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
        case "models.request":
            self = .modelsRequest
        case "model.select":
            self = .modelSelect(modelId: try container.decode(String.self, forKey: .modelId))
        case "thinking.set":
            self = .thinkingSet(
                scoopJid: try container.decode(String.self, forKey: .scoopJid),
                thinkingLevel: try container.decode(
                    TrayThinkingLevel.self, forKey: .thinkingLevel),
                effortOverride: try container.decodeIfPresent(
                    String.self, forKey: .effortOverride))
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
        case "cdp.request":
            self = .cdpRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                targetRuntimeId: try container.decode(String.self, forKey: .targetRuntimeId),
                localTargetId: try container.decode(String.self, forKey: .localTargetId),
                method: try container.decode(String.self, forKey: .method),
                params: try container.decodeIfPresent(AnyCodable.self, forKey: .params),
                sessionId: try container.decodeIfPresent(String.self, forKey: .sessionId))
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
        case "tab.teleport.request":
            self = .tabTeleportRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                targetId: try container.decode(String.self, forKey: .targetId))
        case "fs.request":
            self = .fsRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                targetRuntimeId: try container.decode(String.self, forKey: .targetRuntimeId),
                request: try container.decode(TrayFsRequest.self, forKey: .request))
        case "fs.response":
            self = .fsResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                response: try container.decode(TrayFsResponse.self, forKey: .response))
        case "exec.request":
            self = .execRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                command: try container.decode(String.self, forKey: .command),
                cwd: try container.decodeIfPresent(String.self, forKey: .cwd),
                env: try container.decodeIfPresent([String: String].self, forKey: .env))
        case "exec.chunk":
            self = .execChunk(
                requestId: try container.decode(String.self, forKey: .requestId),
                stream: try container.decode(String.self, forKey: .stream),
                data: try container.decode(String.self, forKey: .data))
        case "exec.response":
            self = .execResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                exitCode: try container.decode(Int.self, forKey: .exitCode),
                signal: try container.decodeIfPresent(String.self, forKey: .signal),
                error: try container.decodeIfPresent(String.self, forKey: .error))
        case "exec.signal":
            self = .execSignal(
                requestId: try container.decode(String.self, forKey: .requestId),
                signal: try container.decode(String.self, forKey: .signal))
        case "lick":
            self = .lick(event: try container.decode(LickEvent.self, forKey: .event))
        case "sudo.approve.response":
            self = .sudoApproveResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                decision: try container.decode(String.self, forKey: .decision),
                pattern: try container.decodeIfPresent(String.self, forKey: .pattern),
                attestation: try container.decodeIfPresent(String.self, forKey: .attestation))
        case "push.register":
            self = .pushRegister(
                platform: try container.decode(String.self, forKey: .platform),
                token: try container.decode(String.self, forKey: .token),
                environment: try container.decode(String.self, forKey: .environment))
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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if try encodeRemoteOperation(to: &container) { return }
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
        case .modelsRequest:
            try container.encode("models.request", forKey: .type)
        case .modelSelect(let modelId):
            try container.encode("model.select", forKey: .type)
            try container.encode(modelId, forKey: .modelId)
        case .thinkingSet(let scoopJid, let thinkingLevel, let effortOverride):
            try container.encode("thinking.set", forKey: .type)
            try container.encode(scoopJid, forKey: .scoopJid)
            try container.encode(thinkingLevel, forKey: .thinkingLevel)
            try container.encodeIfPresent(effortOverride, forKey: .effortOverride)
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
        case .cdpRequest(
            let requestId, let targetRuntimeId, let localTargetId, let method, let params,
            let sessionId):
            try container.encode("cdp.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(targetRuntimeId, forKey: .targetRuntimeId)
            try container.encode(localTargetId, forKey: .localTargetId)
            try container.encode(method, forKey: .method)
            try container.encodeIfPresent(params, forKey: .params)
            try container.encodeIfPresent(sessionId, forKey: .sessionId)
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
        case .tabTeleportRequest(let requestId, let targetId):
            try container.encode("tab.teleport.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(targetId, forKey: .targetId)
        case .fsRequest, .fsResponse, .execRequest, .execChunk, .execResponse, .execSignal:
            return
        case .lick(let event):
            try container.encode("lick", forKey: .type)
            try container.encode(event, forKey: .event)
        case .sudoApproveResponse(let requestId, let decision, let pattern, let attestation):
            try container.encode("sudo.approve.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(decision, forKey: .decision)
            try container.encodeIfPresent(pattern, forKey: .pattern)
            try container.encodeIfPresent(attestation, forKey: .attestation)
        case .pushRegister(let platform, let token, let environment):
            try container.encode("push.register", forKey: .type)
            try container.encode(platform, forKey: .platform)
            try container.encode(token, forKey: .token)
            try container.encode(environment, forKey: .environment)
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

    private func encodeRemoteOperation(
        to container: inout KeyedEncodingContainer<CodingKeys>
    ) throws -> Bool {
        switch self {
        case .fsRequest(let requestId, let targetRuntimeId, let request):
            try container.encode("fs.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(targetRuntimeId, forKey: .targetRuntimeId)
            try container.encode(request, forKey: .request)
        case .fsResponse(let requestId, let response):
            try container.encode("fs.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(response, forKey: .response)
        case .execRequest(let requestId, let command, let cwd, let env):
            try container.encode("exec.request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(command, forKey: .command)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(env, forKey: .env)
        case .execChunk(let requestId, let stream, let data):
            try container.encode("exec.chunk", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(stream, forKey: .stream)
            try container.encode(data, forKey: .data)
        case .execResponse(let requestId, let exitCode, let signal, let error):
            try container.encode("exec.response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(signal, forKey: .signal)
            try container.encodeIfPresent(error, forKey: .error)
        case .execSignal(let requestId, let signal):
            try container.encode("exec.signal", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(signal, forKey: .signal)
        default:
            return false
        }
        return true
    }
}
