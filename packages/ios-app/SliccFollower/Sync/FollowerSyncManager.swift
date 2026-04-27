import Foundation
import os

// MARK: - FollowerSyncDelegate

protocol FollowerSyncDelegate: AnyObject {
    /// Called when a full snapshot of messages is received
    func followerSync(_ sync: FollowerSyncManager, didReceiveSnapshot messages: [ChatMessage])
    /// Called when a streaming delta is received for a message
    func followerSync(_ sync: FollowerSyncManager, didReceiveDelta messageId: String, text: String)
    /// Called when a new assistant message starts streaming
    func followerSync(_ sync: FollowerSyncManager, didStartMessage messageId: String)
    /// Called when a message finishes streaming
    func followerSync(_ sync: FollowerSyncManager, didFinishMessage messageId: String)
    /// Called for tool use events
    func followerSync(_ sync: FollowerSyncManager, didReceiveToolUse messageId: String, toolName: String, input: String)
    func followerSync(_ sync: FollowerSyncManager, didReceiveToolResult messageId: String, toolName: String, result: String, isError: Bool)
    /// Called when a user message from another follower is echoed
    func followerSync(_ sync: FollowerSyncManager, didReceiveUserMessageEcho text: String, messageId: String)
    /// Called when streaming status changes
    func followerSync(_ sync: FollowerSyncManager, didUpdateStatus isProcessing: Bool)
    /// Called on error
    func followerSync(_ sync: FollowerSyncManager, didReceiveError error: String)
    /// Called when connection is lost
    func followerSyncDidDisconnect(_ sync: FollowerSyncManager, reason: String)
}

// MARK: - FollowerSyncManager

class FollowerSyncManager {
    weak var delegate: FollowerSyncDelegate?

    private let sendMessage: (Data) -> Bool
    private var keepalive: DataChannelKeepalive?
    private var snapshotChunkBuffer: SnapshotChunkBuffer?
    private var sentMessageIds: Set<String> = []
    private var disconnected = false

    private let logger = Logger(subsystem: "com.slicc.follower", category: "FollowerSync")

    init(sendMessage: @escaping (Data) -> Bool) {
        self.sendMessage = sendMessage
    }

    // MARK: - Public API

    /// Process a raw message received from the data channel
    func handleMessage(_ data: Data) {
        let decoder = JSONDecoder()
        guard let message = try? decoder.decode(LeaderToFollowerMessage.self, from: data) else {
            logger.warning("Failed to decode leader message")
            return
        }
        handleLeaderMessage(message)
    }

    /// Send a user message to the leader
    func sendUserMessage(_ text: String, messageId: String? = nil) {
        let id = messageId ?? "follower-\(Int(Date().timeIntervalSince1970 * 1000))-\(randomSuffix())"
        sentMessageIds.insert(id)
        send(.userMessage(text: text, messageId: id))
        logger.info("Sent user message to leader: \(id)")
    }

    /// Send abort to stop the agent
    func sendAbort() {
        send(.abort)
        logger.info("Sent abort to leader")
    }

    /// Request a full snapshot from the leader
    func requestSnapshot() {
        send(.requestSnapshot(scoopJid: nil))
    }

    /// Start keepalive
    func startKeepalive() {
        let ka = DataChannelKeepalive(
            sendPing: { [weak self] in
                self?.send(.ping)
            },
            onDead: { [weak self] in
                guard let self else { return }
                self.logger.warning("Leader keepalive dead")
                Task { @MainActor in
                    self.handleDisconnect(reason: "Keepalive timeout — leader not responding")
                }
            }
        )
        self.keepalive = ka
        Task { await ka.start() }
    }

    /// Stop and clean up
    func close() {
        if let ka = keepalive {
            Task { await ka.stop() }
        }
        keepalive = nil
        snapshotChunkBuffer = nil
        sentMessageIds.removeAll()
        logger.info("Follower sync closed")
    }

    // MARK: - Private — Message Routing

    private func handleLeaderMessage(_ message: LeaderToFollowerMessage) {
        switch message {
        case let .snapshot(messages, _):
            snapshotChunkBuffer = nil
            logger.info("Snapshot received, \(messages.count) messages")
            delegate?.followerSync(self, didReceiveSnapshot: messages)

        case let .snapshotChunk(chunkData, chunkIndex, totalChunks, _):
            handleSnapshotChunk(chunkData: chunkData, chunkIndex: chunkIndex, totalChunks: totalChunks)

        case let .agentEvent(event, _):
            routeAgentEvent(event)

        case let .userMessageEcho(text, messageId, _):
            if sentMessageIds.contains(messageId) {
                sentMessageIds.remove(messageId)
                logger.debug("Skipping own message echo: \(messageId)")
                return
            }
            logger.info("User message echo received: \(messageId)")
            delegate?.followerSync(self, didReceiveUserMessageEcho: text, messageId: messageId)

        case let .status(scoopStatus):
            let isProcessing = scoopStatus == "processing"
            delegate?.followerSync(self, didUpdateStatus: isProcessing)

        case let .error(error):
            logger.warning("Error from leader: \(error)")
            delegate?.followerSync(self, didReceiveError: error)

        case .ping:
            if let ka = keepalive {
                Task { await ka.receivedPing() }
            }
            send(.pong)

        case .pong:
            if let ka = keepalive {
                Task { await ka.receivedPong() }
            }

        case .scoopsList, .sprinklesList, .sprinkleContent, .sprinkleUpdate:
            // Newer protocol messages — handled by AppState directly, not by this
            // legacy delegate-based sync manager. Ignored here.
            break

        case .unknown:
            break  // Silently ignore unhandled message types
        }
    }

    private func routeAgentEvent(_ event: AgentEvent) {
        switch event {
        case let .messageStart(messageId):
            delegate?.followerSync(self, didStartMessage: messageId)
        case let .contentDelta(messageId, text):
            delegate?.followerSync(self, didReceiveDelta: messageId, text: text)
        case let .contentDone(messageId):
            delegate?.followerSync(self, didFinishMessage: messageId)
        case let .toolUseStart(messageId, toolName, toolInput):
            let inputStr: String
            if let input = toolInput, let data = try? JSONEncoder().encode(input),
               let str = String(data: data, encoding: .utf8) {
                inputStr = str
            } else {
                inputStr = ""
            }
            delegate?.followerSync(self, didReceiveToolUse: messageId, toolName: toolName, input: inputStr)
        case let .toolResult(messageId, toolName, result, isError):
            delegate?.followerSync(self, didReceiveToolResult: messageId, toolName: toolName, result: result, isError: isError ?? false)
        case let .turnEnd(messageId):
            delegate?.followerSync(self, didFinishMessage: messageId)
        case let .error(error):
            delegate?.followerSync(self, didReceiveError: error)

        case .unknown:
            break  // Silently ignore unhandled event types
        }
    }

    // MARK: - Private — Snapshot Chunk Reassembly

    private struct SnapshotChunkBuffer {
        var chunks: [String?]
        var received: Int
        let totalChunks: Int

        init(totalChunks: Int) {
            self.chunks = Array(repeating: nil, count: totalChunks)
            self.received = 0
            self.totalChunks = totalChunks
        }
    }

    private func handleSnapshotChunk(chunkData: String, chunkIndex: Int, totalChunks: Int) {
        if snapshotChunkBuffer == nil {
            snapshotChunkBuffer = SnapshotChunkBuffer(totalChunks: totalChunks)
        }

        guard var buffer = snapshotChunkBuffer,
              chunkIndex >= 0, chunkIndex < buffer.totalChunks else { return }

        // Only count if this slot hasn't been filled yet (handles duplicates)
        if buffer.chunks[chunkIndex] == nil {
            buffer.chunks[chunkIndex] = chunkData
            buffer.received += 1
            snapshotChunkBuffer = buffer
        }

        guard let currentBuffer = snapshotChunkBuffer,
              currentBuffer.received >= currentBuffer.totalChunks else { return }

        // All chunks received — reassemble
        let assembled = currentBuffer.chunks.compactMap { $0 }.joined()
        snapshotChunkBuffer = nil

        guard let jsonData = assembled.data(using: .utf8) else {
            logger.error("Failed to convert assembled snapshot to data")
            return
        }

        // The assembled JSON is { "messages": [...], "scoopJid": "..." }
        struct SnapshotPayload: Codable {
            let messages: [ChatMessage]
            let scoopJid: String
        }

        do {
            let payload = try JSONDecoder().decode(SnapshotPayload.self, from: jsonData)
            logger.info("Chunked snapshot reassembled, \(payload.messages.count) messages")
            delegate?.followerSync(self, didReceiveSnapshot: payload.messages)
        } catch {
            logger.error("Failed to decode reassembled snapshot: \(error.localizedDescription)")
        }
    }

    // MARK: - Private — Sending

    private func send(_ message: FollowerToLeaderMessage) {
        guard let data = try? JSONEncoder().encode(message) else {
            logger.error("Failed to encode follower message")
            return
        }
        _ = sendMessage(data)
    }

    // MARK: - Private — Disconnect

    private func handleDisconnect(reason: String) {
        guard !disconnected else { return }
        disconnected = true
        delegate?.followerSync(self, didReceiveError: "Connection to leader lost: \(reason)")
        close()
        delegate?.followerSyncDidDisconnect(self, reason: reason)
    }

    // MARK: - Private — Helpers

    private func randomSuffix() -> String {
        let chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return String((0..<6).map { _ in chars.randomElement()! })
    }
}
