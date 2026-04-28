import Foundation
import SwiftUI
import WebKit
import WebRTC
import os

/// Represents the current connection state of the follower app.
enum ConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
}

// ChatMessage is defined in Models/ChatMessage.swift

/// Wrapper for decoding chunked snapshot payloads.
/// The leader serializes snapshots as `JSON.stringify({ messages, scoopJid })`.
private struct SnapshotPayload: Codable {
    let messages: [ChatMessage]
    let scoopJid: String
}

/// Global app state shared across views via @EnvironmentObject.
///
/// Central coordinator wiring: TraySignaling → WebRTC → sync → UI.
/// Owns the connection lifecycle, decodes leader messages, and exposes
/// @Published properties for SwiftUI views.
@MainActor
class AppState: ObservableObject {

    // MARK: - Logging

    private let logger = Logger(subsystem: "com.slicc.follower", category: "AppState")

    // MARK: - Published UI State

    @Published var connectionState: ConnectionState = .disconnected
    @Published var joinUrl: String = ""
    @Published var trayId: String?
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming: Bool = false

    // Multi-scoop awareness
    /// All scoops the leader has registered (cone first), updated via `scoops.list`.
    @Published var scoops: [ScoopSummary] = []
    /// JID of the scoop this follower is currently viewing (independent from leader's selection).
    @Published var selectedScoopJid: String?
    /// JID of the leader's currently active scoop (informational; used to mark the active row).
    @Published var leaderActiveScoopJid: String?
    /// Per-scoop message buffers. Source of truth for `messages`.
    private var messagesByScoop: [String: [ChatMessage]] = [:]

    // Sprinkle awareness
    @Published var sprinkles: [SprinkleSummary] = []
    /// In-memory cache of fetched sprinkle .shtml content keyed by sprinkle name.
    @Published var sprinkleContents: [String: String] = [:]
    /// Pending fetch requests waiting for chunked content; keyed by requestId.
    private var pendingSprinkleFetches: [String: SprinkleFetchBuffer] = [:]
    /// Inflight requestIds keyed by sprinkleName, used to dedupe concurrent fetches.
    private var inflightSprinkleNameToRequest: [String: String] = [:]
    /// Continuations awaiting sprinkle content (sprinkleName -> [continuations]).
    private var sprinkleContentWaiters: [String: [CheckedContinuation<String, Error>]] = [:]
    /// Most recent sprinkle update payloads keyed by sprinkle name. Drained by views.
    @Published var sprinkleUpdates: [String: AnyCodable] = [:]

    // Connection metadata (populated after successful connect)
    @Published var leaderConnected: Bool = false
    @Published var participantCount: Int = 0
    @Published var connectedSince: Date?
    @Published var autoReconnect: Bool = true

    // Join URL history (last 5)
    @Published var joinUrlHistory: [String] = []

    /// Last connection error, surfaced to the UI.
    @Published var lastError: String?

    /// Buffer for chunked sprinkle.content responses.
    private struct SprinkleFetchBuffer {
        let sprinkleName: String
        var chunks: [Int: String] = [:]
        var totalChunks: Int = 1
    }

    // MARK: - Init

    init() {
        if let history = UserDefaults.standard.stringArray(forKey: "joinUrlHistory") {
            joinUrlHistory = history
        }
    }

    // MARK: - Streaming Bridge

    /// Closure the view layer can set to receive streaming deltas
    /// (e.g. MessageWebView coordinator calls evaluateJavaScript).
    /// Parameters: (eventName, messageId, payload)
    var onStreamingEvent: ((_ event: StreamingEvent) -> Void)?

    /// Events forwarded to the WebView for incremental rendering.
    enum StreamingEvent {
        case messageStart(messageId: String)
        case contentDelta(messageId: String, text: String)
        case contentDone(messageId: String)
        case toolUseStart(messageId: String, toolName: String, toolInput: String)
    }

    // MARK: - Private Networking / Sync

    // These are fileprivate so WebRTCBridge (same file) can access them.
    fileprivate var signalingClient: TraySignalingClient?
    private var webRTCManager: WebRTCManager?
    private var webRTCDelegate: WebRTCBridge?
    private var keepalive: DataChannelKeepalive?
    private var connectTask: Task<Void, Never>?
    fileprivate var controllerId: String = UUID().uuidString
    fileprivate var currentBootstrapId: String?

    /// Snapshot chunks being accumulated for reassembly.
    private var snapshotChunks: [Int: String] = [:]
    private var snapshotTotalChunks: Int = 0

    /// ID of the message currently being streamed.
    private var streamingMessageId: String?

    // MARK: - CDP / federated targets

    /// CDP bridge — owns WKWebViews, dispatches CDP commands.
    private var cdpBridge: CDPBridge?
    /// Periodic timer for re-advertising targets.
    private var targetsAdvertiseTimer: Timer?
    /// Visible carousel of locally-hosted CDP targets (one per WKWebView).
    @Published var cdpTargets: [CDPTargetSummary] = []

    // MARK: - Connection Lifecycle

    /// Attempt to connect to the tray using the current joinUrl.
    func connect() {
        let trimmed = joinUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return }
        guard connectionState != .connecting else { return }

        connectionState = .connecting
        lastError = nil
        addToHistory(joinUrl)

        // Tear down any previous connection first.
        tearDown()

        controllerId = UUID().uuidString
        let client = TraySignalingClient(joinUrl: url)
        signalingClient = client

        let rtc = WebRTCManager()
        webRTCManager = rtc
        let bridge = WebRTCBridge(appState: self)
        webRTCDelegate = bridge
        rtc.delegate = bridge

        connectTask = Task { [weak self] in
            guard let self else { return }
            await self.runSignalingLoop(client: client, rtc: rtc)
        }
    }

    /// Disconnect from the current tray session.
    func disconnect() {
        tearDown()
        connectionState = .disconnected
        trayId = nil
        leaderConnected = false
        participantCount = 0
        connectedSince = nil
        isStreaming = false
        streamingMessageId = nil
        scoops = []
        selectedScoopJid = nil
        leaderActiveScoopJid = nil
        messagesByScoop.removeAll()
        sprinkles = []
        sprinkleContents.removeAll()
        sprinkleUpdates.removeAll()
        pendingSprinkleFetches.removeAll()
        inflightSprinkleNameToRequest.removeAll()
        // Resolve any pending waiters with an error so callers don't hang.
        let waiters = sprinkleContentWaiters
        sprinkleContentWaiters.removeAll()
        for (_, list) in waiters {
            for waiter in list {
                waiter.resume(throwing: SprinkleFetchError.fetchFailed("Disconnected"))
            }
        }
    }

    /// Clear all stored data (history, credentials, etc.)
    func clearStoredData() {
        joinUrlHistory = []
        UserDefaults.standard.removeObject(forKey: "joinUrlHistory")
        UserDefaults.standard.removeObject(forKey: "joinUrl")
    }

    // MARK: - UI Actions

    /// Send a user message to the agent via the data channel.
    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let messageId = UUID().uuidString
        let message = ChatMessage(
            id: messageId,
            role: .user,
            content: trimmed,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        messages.append(message)
        // Mirror into the per-scoop buffer so swipe-back retains the message.
        if let jid = selectedScoopJid {
            messagesByScoop[jid, default: []].append(message)
        }

        let msg = FollowerToLeaderMessage.userMessage(text: trimmed, messageId: messageId)
        sendToLeader(msg)
    }

    /// Abort the current streaming response.
    func abort() {
        isStreaming = false
        streamingMessageId = nil
        sendToLeader(.abort)
    }

    // MARK: - Scoop Switching

    /// Select a specific scoop to view. Independent of the leader's selection.
    func selectScoop(jid: String) {
        guard jid != selectedScoopJid else { return }
        guard scoops.contains(where: { $0.jid == jid }) else { return }
        selectedScoopJid = jid
        // Show whatever we already have buffered, then request a fresh snapshot.
        let cached = messagesByScoop[jid] ?? []
        messages = cached
        isStreaming = cached.last?.isStreaming == true
        streamingMessageId = isStreaming ? cached.last?.id : nil
        sendToLeader(.requestSnapshot(scoopJid: jid))
    }

    /// Swipe left → next scoop in the list. Wraps around to the first when at end.
    func swipeToNextScoop() {
        guard !scoops.isEmpty else { return }
        let currentIndex = scoops.firstIndex(where: { $0.jid == selectedScoopJid }) ?? 0
        let nextIndex = (currentIndex + 1) % scoops.count
        selectScoop(jid: scoops[nextIndex].jid)
    }

    /// Swipe right → previous scoop. Falls back to the cone if we'd otherwise
    /// underflow (matches the user's "or cone if no more are left" expectation).
    func swipeToPreviousScoop() {
        guard !scoops.isEmpty else { return }
        let currentIndex = scoops.firstIndex(where: { $0.jid == selectedScoopJid }) ?? 0
        if currentIndex > 0 {
            selectScoop(jid: scoops[currentIndex - 1].jid)
        } else if let cone = scoops.first(where: { $0.isCone }) {
            selectScoop(jid: cone.jid)
        }
    }

    /// The summary for the currently-viewed scoop, if any.
    var selectedScoop: ScoopSummary? {
        scoops.first(where: { $0.jid == selectedScoopJid })
    }

    // MARK: - Sprinkles

    /// Ask the leader to refresh the sprinkle list.
    func refreshSprinkles() {
        sendToLeader(.sprinklesRefresh)
    }

    /// Fetch the raw .shtml content for a sprinkle. Returns cached content
    /// when available, otherwise sends a `sprinkle.fetch` and awaits the
    /// reassembled response. Throws on transport / leader errors.
    func fetchSprinkleContent(_ sprinkleName: String) async throws -> String {
        if let cached = sprinkleContents[sprinkleName] { return cached }
        let requestId = UUID().uuidString
        // Dedupe concurrent fetches for the same sprinkle.
        if inflightSprinkleNameToRequest[sprinkleName] == nil {
            inflightSprinkleNameToRequest[sprinkleName] = requestId
            pendingSprinkleFetches[requestId] = SprinkleFetchBuffer(sprinkleName: sprinkleName)
            sendToLeader(.sprinkleFetch(requestId: requestId, sprinkleName: sprinkleName))
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            sprinkleContentWaiters[sprinkleName, default: []].append(continuation)
        }
    }

    /// Forward a sprinkle lick (from a panel or inline sprinkle) to the leader.
    func sendSprinkleLick(_ sprinkleName: String, body: AnyCodable?, targetScoop: String? = nil) {
        sendToLeader(.sprinkleLick(
            sprinkleName: sprinkleName,
            body: body,
            targetScoop: targetScoop
        ))
    }

    /// Reassemble chunked sprinkle.content responses and resolve waiters.
    private func handleSprinkleContent(
        requestId: String,
        sprinkleName: String,
        content: String,
        chunkIndex: Int?,
        totalChunks: Int?,
        error: String?
    ) {
        if let error = error {
            logger.error("sprinkle.content error for \(sprinkleName): \(error)")
            pendingSprinkleFetches.removeValue(forKey: requestId)
            inflightSprinkleNameToRequest.removeValue(forKey: sprinkleName)
            let waiters = sprinkleContentWaiters.removeValue(forKey: sprinkleName) ?? []
            for waiter in waiters {
                waiter.resume(throwing: SprinkleFetchError.fetchFailed(error))
            }
            return
        }

        let assembled: String?
        if let chunkIndex = chunkIndex, let totalChunks = totalChunks {
            var buffer = pendingSprinkleFetches[requestId]
                ?? SprinkleFetchBuffer(sprinkleName: sprinkleName)
            buffer.totalChunks = totalChunks
            buffer.chunks[chunkIndex] = content
            pendingSprinkleFetches[requestId] = buffer
            if buffer.chunks.count >= totalChunks {
                assembled = (0..<totalChunks)
                    .compactMap { buffer.chunks[$0] }
                    .joined()
                pendingSprinkleFetches.removeValue(forKey: requestId)
            } else {
                assembled = nil
            }
        } else {
            assembled = content
            pendingSprinkleFetches.removeValue(forKey: requestId)
        }

        guard let final = assembled else { return }
        sprinkleContents[sprinkleName] = final
        inflightSprinkleNameToRequest.removeValue(forKey: sprinkleName)
        let waiters = sprinkleContentWaiters.removeValue(forKey: sprinkleName) ?? []
        for waiter in waiters {
            waiter.resume(returning: final)
        }
    }

    enum SprinkleFetchError: LocalizedError {
        case fetchFailed(String)

        var errorDescription: String? {
            switch self {
            case let .fetchFailed(reason):
                return "Failed to load sprinkle: \(reason)"
            }
        }
    }

    // MARK: - Private: Signaling Loop

    /// Runs the full attach → poll → offer → answer → ICE → connected flow.
    private func runSignalingLoop(client: TraySignalingClient, rtc: WebRTCManager) async {
        do {
            // Step 1: Attach — may need to retry if leader not yet connected.
            let plan = try await attachWithRetry(client: client)

            self.trayId = plan.trayId
            self.participantCount = plan.participantCount
            self.leaderConnected = plan.leader?.connected ?? false

            guard let bootstrap = plan.bootstrap,
                  let iceServers = plan.iceServers else {
                self.connectionState = .failed
                self.lastError = "Attach succeeded but no bootstrap or ICE servers"
                return
            }

            // Step 2: Configure WebRTC with TURN servers.
            rtc.configure(iceServers: iceServers)

            // Step 3: Poll for offer and ICE candidates.
            let bootstrapId = bootstrap.bootstrapId
            self.currentBootstrapId = bootstrapId
            var cursor: Int? = bootstrap.cursor

            // Process any events already present in the attach response.
            // (The attach response doesn't include events; they come from poll.)

            var gotOffer = false
            let maxPolls = 60 // Safety limit
            for _ in 0..<maxPolls {
                if Task.isCancelled { return }

                let poll = try await client.pollBootstrap(
                    controllerId: controllerId,
                    bootstrapId: bootstrapId,
                    cursor: cursor
                )
                cursor = poll.bootstrap.cursor

                self.participantCount = poll.participantCount
                self.leaderConnected = poll.leader?.connected ?? false

                for event in poll.events {
                    switch event {
                    case .offer(_, _, let offer):
                        let answer = try await rtc.handleOffer(sdp: offer.sdp)
                        let answerDesc = TraySessionDescription(
                            type: .answer, sdp: answer.sdp)
                        _ = try await client.sendAnswer(
                            controllerId: controllerId,
                            bootstrapId: bootstrapId,
                            answer: answerDesc
                        )
                        gotOffer = true

                    case .iceCandidate(_, _, let cand):
                        try await rtc.addIceCandidate(
                            candidate: cand.candidate,
                            sdpMid: cand.sdpMid,
                            sdpMLineIndex: cand.sdpMLineIndex.map { Int32($0) }
                        )

                    case .failed(_, _, let failure):
                        self.connectionState = .failed
                        self.lastError = failure.message
                        return
                    }
                }

                // Check if we're connected now.
                if poll.bootstrap.state == .connected {
                    break
                }

                // If we have the offer + answer, wait for data channel open
                // (WebRTCManager delegate will call dataChannelOpened).
                if gotOffer && poll.events.isEmpty {
                    // Brief pause before next poll.
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }

                // If no events, the leader hasn't sent anything yet — pause.
                if poll.events.isEmpty && !gotOffer {
                    let delay = poll.bootstrap.retryAfterMs ?? 2000
                    try? await Task.sleep(
                        nanoseconds: UInt64(delay) * 1_000_000)
                }
            }

        } catch is CancellationError {
            return
        } catch {
            self.connectionState = .failed
            self.lastError = error.localizedDescription
        }
    }

    /// Attach to the tray, retrying when the leader isn't connected yet.
    private func attachWithRetry(client: TraySignalingClient) async throws -> FollowerAttachPlan {
        let maxAttempts = 30
        for _ in 0..<maxAttempts {
            if Task.isCancelled { throw CancellationError() }

            let plan = try await client.attach(controllerId: controllerId)

            switch plan.action {
            case .signal:
                return plan
            case .wait:
                let delay = plan.retryAfterMs ?? 2000
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            case .fail:
                throw AppStateError.attachFailed(plan.error ?? plan.code)
            }
        }
        throw AppStateError.attachFailed("Max attach retries exceeded")
    }

    // MARK: - Private: Data Channel Message Handling

    /// Called from WebRTCBridge when the data channel opens.
    func dataChannelOpened() {
        logger.info("Data channel opened")
        connectionState = .connected
        connectedSince = Date()

        // Spin up the CDP bridge and advertise (initially empty) targets so
        // the leader knows we can host federated WKWebView targets.
        let bridge = CDPBridge(runtimeId: controllerId) { [weak self] msg in
            self?.sendToLeader(msg)
        }
        bridge.onTargetsChanged = { [weak self] in
            Task { @MainActor in self?.refreshCDPTargets() }
        }
        cdpBridge = bridge
        bridge.advertiseTargets()
        refreshCDPTargets()
        startTargetsAdvertiseTimer()

        // Start keepalive.
        let rtc = webRTCManager
        keepalive = DataChannelKeepalive(
            sendPing: { [weak rtc] in
                guard let rtc else { return }
                if let data = try? JSONEncoder().encode(FollowerToLeaderMessage.ping) {
                    rtc.sendData(data)
                }
            },
            onDead: { [weak self] in
                Task { @MainActor [weak self] in
                    self?.handleDisconnect(reason: "Keepalive timeout")
                }
            }
        )
        Task { await keepalive?.start() }

        // Request initial snapshot.
        sendToLeader(.requestSnapshot(scoopJid: nil))
    }

    /// Called from WebRTCBridge when data arrives on the channel.
    func handleDataChannelMessage(_ data: Data) {
        let decoder = JSONDecoder()

        let msg: LeaderToFollowerMessage
        do {
            msg = try decoder.decode(LeaderToFollowerMessage.self, from: data)
        } catch {
            let preview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode leader message (\(data.count) bytes): \(error.localizedDescription) — preview: \(preview)")
            return
        }

        switch msg {
        case let .snapshot(chatMessages, scoopJid):
            logger.info("Snapshot received: \(chatMessages.count) messages, scoopJid=\(scoopJid)")
            ingestSnapshot(messages: chatMessages, scoopJid: scoopJid)

        case let .snapshotChunk(chunkData, chunkIndex, totalChunks, _):
            logger.info("Snapshot chunk \(chunkIndex + 1)/\(totalChunks) received (\(chunkData.count) chars)")
            snapshotTotalChunks = totalChunks
            snapshotChunks[chunkIndex] = chunkData
            if snapshotChunks.count == totalChunks {
                let fullJson = (0..<totalChunks).compactMap { snapshotChunks[$0] }.joined()
                snapshotChunks.removeAll()
                logger.info("Reassembling chunked snapshot (\(fullJson.count) chars total)")
                if let jsonData = fullJson.data(using: .utf8) {
                    do {
                        let payload = try JSONDecoder().decode(SnapshotPayload.self, from: jsonData)
                        logger.info("Chunked snapshot decoded: \(payload.messages.count) messages, scoopJid=\(payload.scoopJid)")
                        ingestSnapshot(messages: payload.messages, scoopJid: payload.scoopJid)
                    } catch {
                        logger.error("Failed to decode reassembled snapshot: \(error.localizedDescription)")
                        let preview = String(fullJson.prefix(300))
                        logger.error("Snapshot JSON preview: \(preview)")
                    }
                }
            }

        case let .agentEvent(event, scoopJid):
            logger.debug("Agent event received: scoopJid=\(scoopJid)")
            handleAgentEvent(event, scoopJid: scoopJid)

        case let .userMessageEcho(text, messageId, scoopJid):
            logger.debug("User message echo: id=\(messageId)")
            var buffer = messagesByScoop[scoopJid] ?? []
            if !buffer.contains(where: { $0.id == messageId }) {
                let msg = ChatMessage(
                    id: messageId,
                    role: .user,
                    content: text,
                    timestamp: Date().timeIntervalSince1970 * 1000
                )
                buffer.append(msg)
                messagesByScoop[scoopJid] = buffer
                if scoopJid == selectedScoopJid {
                    messages = buffer
                }
            }

        case let .status(scoopStatus):
            logger.debug("Status update: \(scoopStatus)")
            let wasStreaming = isStreaming
            isStreaming = (scoopStatus == "streaming" || scoopStatus == "running")
            if wasStreaming && !isStreaming {
                streamingMessageId = nil
            }

        case let .error(error):
            logger.error("Leader error: \(error)")
            lastError = error

        case let .scoopsList(scoops, activeScoopJid):
            logger.info("Scoops list received: \(scoops.count) scoops, active=\(activeScoopJid)")
            self.scoops = scoops
            self.leaderActiveScoopJid = activeScoopJid
            // First time we hear about scoops: select the cone (or the active one) for viewing.
            if selectedScoopJid == nil {
                let cone = scoops.first(where: { $0.isCone })
                let initial = cone?.jid ?? activeScoopJid
                if !initial.isEmpty {
                    selectedScoopJid = initial
                    // Pull buffered messages for this scoop if we haven't yet.
                    if messagesByScoop[initial] == nil {
                        sendToLeader(.requestSnapshot(scoopJid: initial))
                    } else {
                        messages = messagesByScoop[initial] ?? []
                    }
                }
            }

        case let .sprinklesList(sprinkles):
            logger.info("Sprinkles list received: \(sprinkles.count) sprinkles")
            self.sprinkles = sprinkles

        case let .sprinkleContent(requestId, sprinkleName, content, chunkIndex, totalChunks, error):
            handleSprinkleContent(
                requestId: requestId,
                sprinkleName: sprinkleName,
                content: content,
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                error: error
            )

        case let .sprinkleUpdate(sprinkleName, data):
            logger.debug("Sprinkle update for \(sprinkleName)")
            if let data = data {
                sprinkleUpdates[sprinkleName] = data
            }

        case let .cdpRequest(requestId, localTargetId, method, params, sessionId):
            logger.debug("CDP request \(method) target=\(localTargetId)")
            cdpBridge?.handleRequest(
                requestId: requestId,
                localTargetId: localTargetId,
                method: method,
                params: params,
                sessionId: sessionId
            )

        case let .tabOpen(requestId, url):
            logger.info("Leader requested new tab: \(url)")
            cdpBridge?.handleTabOpen(requestId: requestId, url: url)

        case .targetsRegistry:
            // Informational — registry of all federated targets across the tray.
            // We don't act on it locally; relevant only for cross-runtime CDP.
            break

        case .ping:
            sendToLeader(.pong)
            Task { await keepalive?.receivedPing() }

        case .pong:
            Task { await keepalive?.receivedPong() }

        case .unknown:
            logger.debug("Unknown message type received")
            break  // Silently ignore unhandled message types
        }
    }

    // MARK: - CDP advertise timer

    private func startTargetsAdvertiseTimer() {
        targetsAdvertiseTimer?.invalidate()
        targetsAdvertiseTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) {
            [weak self] _ in
            Task { @MainActor in
                self?.cdpBridge?.advertiseTargets()
            }
        }
    }

    private func stopTargetsAdvertiseTimer() {
        targetsAdvertiseTimer?.invalidate()
        targetsAdvertiseTimer = nil
    }

    /// Refresh the published `cdpTargets` from the bridge.
    private func refreshCDPTargets() {
        cdpTargets = cdpBridge?.currentTargets() ?? []
    }

    /// Accessor for the live WKWebView backing a CDP target. Returns nil if
    /// the target is gone or the bridge isn't running.
    func cdpWebView(for targetId: String) -> WKWebView? {
        cdpBridge?.webView(for: targetId)
    }

    /// Manually open a new tab (e.g. from a UI button). Mirrors `tab.open`.
    func cdpOpenTab(url: String = "about:blank") {
        cdpBridge?.handleTabOpen(requestId: "ui-\(UUID().uuidString)", url: url)
    }

    /// Manually close a tab from the carousel.
    func cdpCloseTab(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-close-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Target.closeTarget",
            params: AnyCodable(["targetId": targetId]),
            sessionId: nil
        )
    }

    /// Reload a tab.
    func cdpBridgeReload(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-reload-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Page.reload",
            params: nil,
            sessionId: nil
        )
    }

    /// Apply a snapshot payload for `scoopJid` to the per-scoop buffer, and
    /// refresh `messages` if it matches the currently-viewed scoop.
    private func ingestSnapshot(messages chatMessages: [ChatMessage], scoopJid: String) {
        messagesByScoop[scoopJid] = chatMessages
        if selectedScoopJid == nil { selectedScoopJid = scoopJid }
        if scoopJid == selectedScoopJid {
            messages = chatMessages
            isStreaming = chatMessages.last?.isStreaming == true
            streamingMessageId = isStreaming ? chatMessages.last?.id : nil
        }
    }

    /// Process an AgentEvent from the leader, routing into the right scoop buffer.
    private func handleAgentEvent(_ event: AgentEvent, scoopJid: String) {
        var buffer = messagesByScoop[scoopJid] ?? []
        let isVisible = (scoopJid == selectedScoopJid)

        switch event {
        case let .messageStart(messageId):
            logger.info("Agent event: message_start id=\(messageId) scoop=\(scoopJid)")
            let newMsg = ChatMessage(
                id: messageId,
                role: .assistant,
                content: "",
                timestamp: Date().timeIntervalSince1970 * 1000,
                isStreaming: true
            )
            buffer.append(newMsg)
            messagesByScoop[scoopJid] = buffer
            if isVisible {
                messages = buffer
                isStreaming = true
                streamingMessageId = messageId
                onStreamingEvent?(.messageStart(messageId: messageId))
            }

        case let .contentDelta(messageId, text):
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].content += text
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    messages = buffer
                    onStreamingEvent?(.contentDelta(messageId: messageId, text: text))
                }
            }

        case let .contentDone(messageId):
            logger.debug("Agent event: content_done id=\(messageId)")
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].isStreaming = false
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    messages = buffer
                    onStreamingEvent?(.contentDone(messageId: messageId))
                }
            }

        case let .toolUseStart(messageId, toolName, toolInput):
            logger.info("Agent event: tool_use_start id=\(messageId) tool=\(toolName)")
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                let inputStr: String
                if let toolInput, let data = try? JSONEncoder().encode(toolInput),
                   let str = String(data: data, encoding: .utf8) {
                    inputStr = str
                } else {
                    inputStr = "{}"
                }
                let tc = ToolCall(id: UUID().uuidString, name: toolName, input: toolInput)
                if buffer[idx].toolCalls == nil {
                    buffer[idx].toolCalls = [tc]
                } else {
                    buffer[idx].toolCalls?.append(tc)
                }
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    messages = buffer
                    onStreamingEvent?(.toolUseStart(
                        messageId: messageId, toolName: toolName, toolInput: inputStr))
                }
            }

        case let .toolResult(messageId, toolName, result, isError):
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                if let tcIdx = buffer[idx].toolCalls?.lastIndex(where: { $0.name == toolName }) {
                    buffer[idx].toolCalls?[tcIdx].result = result
                    buffer[idx].toolCalls?[tcIdx].isError = isError
                    messagesByScoop[scoopJid] = buffer
                    if isVisible { messages = buffer }
                }
            }

        case let .turnEnd(messageId):
            logger.info("Agent event: turn_end id=\(messageId)")
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].isStreaming = false
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    messages = buffer
                    isStreaming = false
                    streamingMessageId = nil
                }
            }

        case let .error(error):
            logger.error("Agent event: error — \(error)")
            if isVisible { lastError = error }

        case .unknown:
            logger.debug("Agent event: unknown type")
            break
        }
    }

    // MARK: - Private: Send to Leader

    private func sendToLeader(_ msg: FollowerToLeaderMessage) {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        webRTCManager?.sendData(data)
    }

    // MARK: - Private: Disconnect Handling

    /// Called when WebRTC or keepalive detects a disconnect.
    func handleDisconnect(reason: String) {
        guard connectionState == .connected || connectionState == .reconnecting else { return }

        if autoReconnect {
            connectionState = .reconnecting
            streamingMessageId = nil
            // TODO: Implement reconnect with exponential backoff.
            // For now, attempt a fresh connect after a delay.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self, self.connectionState == .reconnecting else { return }
                self.connect()
            }
        } else {
            connectionState = .failed
            lastError = reason
        }
    }

    // MARK: - Private: Teardown

    private func tearDown() {
        connectTask?.cancel()
        connectTask = nil
        Task { await keepalive?.stop() }
        keepalive = nil
        webRTCManager?.close()
        webRTCManager = nil
        webRTCDelegate = nil
        signalingClient = nil
        snapshotChunks.removeAll()
        // Drop CDP bridge state.
        stopTargetsAdvertiseTimer()
        cdpBridge?.reset()
        cdpBridge = nil
        cdpTargets.removeAll()
    }

    // MARK: - Private: History

    private func addToHistory(_ url: String) {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        joinUrlHistory.removeAll { $0 == trimmed }
        joinUrlHistory.insert(trimmed, at: 0)
        if joinUrlHistory.count > 5 {
            joinUrlHistory = Array(joinUrlHistory.prefix(5))
        }
        UserDefaults.standard.set(joinUrlHistory, forKey: "joinUrlHistory")
    }
}

// MARK: - WebRTCBridge

/// Non-@MainActor delegate that bridges WebRTC callbacks to AppState on the main actor.
/// WebRTCManager delegate methods are called from WebRTC's internal threads.
private class WebRTCBridge: NSObject, WebRTCManagerDelegate {
    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
    }

    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            self?.appState?.dataChannelOpened()
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data) {
        Task { @MainActor [weak self] in
            self?.appState?.handleDataChannelMessage(data)
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState) {
        // Informational — disconnect is handled by the specific disconnect callback.
    }

    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate) {
        Task { @MainActor [weak self] in
            guard let self, let appState = self.appState else { return }
            // Forward local ICE candidates to the signaling server.
            guard let client = appState.signalingClient else { return }
            let trayCandidate = TrayIceCandidate(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex),
                usernameFragment: nil
            )
            // Fire-and-forget; best-effort delivery.
            Task {
                _ = try? await client.sendIceCandidate(
                    controllerId: appState.controllerId,
                    bootstrapId: appState.currentBootstrapId ?? "",
                    candidate: trayCandidate
                )
            }
        }
    }

    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String) {
        Task { @MainActor [weak self] in
            self?.appState?.handleDisconnect(reason: reason)
        }
    }
}

// MARK: - AppStateError

enum AppStateError: LocalizedError {
    case attachFailed(String)

    var errorDescription: String? {
        switch self {
        case let .attachFailed(reason):
            return "Failed to attach to tray: \(reason)"
        }
    }
}

