import Foundation
import SwiftUI
import WebRTC

/// Represents the current connection state of the follower app.
enum ConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
}

// ChatMessage is defined in Models/ChatMessage.swift

/// Global app state shared across views via @EnvironmentObject.
///
/// Central coordinator wiring: TraySignaling → WebRTC → sync → UI.
/// Owns the connection lifecycle, decodes leader messages, and exposes
/// @Published properties for SwiftUI views.
@MainActor
class AppState: ObservableObject {

    // MARK: - Published UI State

    @Published var connectionState: ConnectionState = .disconnected
    @Published var joinUrl: String = ""
    @Published var trayId: String?
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming: Bool = false

    // Connection metadata (populated after successful connect)
    @Published var leaderConnected: Bool = false
    @Published var participantCount: Int = 0
    @Published var connectedSince: Date?
    @Published var autoReconnect: Bool = true

    // Join URL history (last 5)
    @Published var joinUrlHistory: [String] = []

    /// Last connection error, surfaced to the UI.
    @Published var lastError: String?

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

        let msg = FollowerToLeaderMessage.userMessage(text: trimmed, messageId: messageId)
        sendToLeader(msg)
    }

    /// Abort the current streaming response.
    func abort() {
        isStreaming = false
        streamingMessageId = nil
        sendToLeader(.abort)
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
        connectionState = .connected
        connectedSince = Date()

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
        sendToLeader(.requestSnapshot)
    }

    /// Called from WebRTCBridge when data arrives on the channel.
    func handleDataChannelMessage(_ data: Data) {
        let decoder = JSONDecoder()
        guard let msg = try? decoder.decode(LeaderToFollowerMessage.self, from: data) else {
            print("[AppState] Failed to decode leader message (\(data.count) bytes)")
            return
        }

        switch msg {
        case let .snapshot(chatMessages, _):
            messages = chatMessages
            isStreaming = chatMessages.last?.isStreaming == true
            streamingMessageId = isStreaming ? chatMessages.last?.id : nil

        case let .snapshotChunk(chunkData, chunkIndex, totalChunks, _):
            snapshotTotalChunks = totalChunks
            snapshotChunks[chunkIndex] = chunkData
            if snapshotChunks.count == totalChunks {
                // Reassemble snapshot.
                let fullJson = (0..<totalChunks).compactMap { snapshotChunks[$0] }.joined()
                snapshotChunks.removeAll()
                if let data = fullJson.data(using: .utf8),
                   let chatMessages = try? JSONDecoder().decode([ChatMessage].self, from: data) {
                    messages = chatMessages
                    isStreaming = chatMessages.last?.isStreaming == true
                    streamingMessageId = isStreaming ? chatMessages.last?.id : nil
                }
            }

        case let .agentEvent(event, _):
            handleAgentEvent(event)

        case let .userMessageEcho(text, messageId, _):
            // Only add if not already present (we optimistically added in sendMessage).
            if !messages.contains(where: { $0.id == messageId }) {
                let msg = ChatMessage(
                    id: messageId,
                    role: .user,
                    content: text,
                    timestamp: Date().timeIntervalSince1970 * 1000
                )
                messages.append(msg)
            }

        case let .status(scoopStatus):
            let wasStreaming = isStreaming
            isStreaming = (scoopStatus == "streaming" || scoopStatus == "running")
            if wasStreaming && !isStreaming {
                streamingMessageId = nil
            }

        case let .error(error):
            lastError = error

        case .ping:
            sendToLeader(.pong)
            Task { await keepalive?.receivedPing() }

        case .pong:
            Task { await keepalive?.receivedPong() }

        case .unknown:
            break  // Silently ignore unhandled message types
        }
    }

    /// Process an AgentEvent from the leader, updating messages and streaming state.
    private func handleAgentEvent(_ event: AgentEvent) {
        switch event {
        case let .messageStart(messageId):
            let newMsg = ChatMessage(
                id: messageId,
                role: .assistant,
                content: "",
                timestamp: Date().timeIntervalSince1970 * 1000,
                isStreaming: true
            )
            messages.append(newMsg)
            isStreaming = true
            streamingMessageId = messageId
            onStreamingEvent?(.messageStart(messageId: messageId))

        case let .contentDelta(messageId, text):
            if let idx = messages.firstIndex(where: { $0.id == messageId }) {
                messages[idx].content += text
            }
            onStreamingEvent?(.contentDelta(messageId: messageId, text: text))

        case let .contentDone(messageId):
            if let idx = messages.firstIndex(where: { $0.id == messageId }) {
                messages[idx].isStreaming = false
            }
            onStreamingEvent?(.contentDone(messageId: messageId))

        case let .toolUseStart(messageId, toolName, toolInput):
            if let idx = messages.firstIndex(where: { $0.id == messageId }) {
                let inputStr: String
                if let toolInput, let data = try? JSONEncoder().encode(toolInput),
                   let str = String(data: data, encoding: .utf8) {
                    inputStr = str
                } else {
                    inputStr = "{}"
                }
                let tc = ToolCall(id: UUID().uuidString, name: toolName, input: toolInput)
                if messages[idx].toolCalls == nil {
                    messages[idx].toolCalls = [tc]
                } else {
                    messages[idx].toolCalls?.append(tc)
                }
                onStreamingEvent?(.toolUseStart(
                    messageId: messageId, toolName: toolName, toolInput: inputStr))
            }

        case let .toolResult(messageId, toolName, result, isError):
            if let idx = messages.firstIndex(where: { $0.id == messageId }) {
                if let tcIdx = messages[idx].toolCalls?.lastIndex(where: { $0.name == toolName }) {
                    messages[idx].toolCalls?[tcIdx].result = result
                    messages[idx].toolCalls?[tcIdx].isError = isError
                }
            }

        case let .turnEnd(messageId):
            if let idx = messages.firstIndex(where: { $0.id == messageId }) {
                messages[idx].isStreaming = false
            }
            isStreaming = false
            streamingMessageId = nil

        case let .error(error):
            lastError = error

        case .unknown:
            break  // Silently ignore unhandled event types
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

