import SwiftUI

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
@MainActor
class AppState: ObservableObject {
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

    /// Attempt to connect to the tray using the current joinUrl.
    func connect() {
        guard !joinUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        connectionState = .connecting
        addToHistory(joinUrl)
        // TODO: Wire up TraySignalingClient + WebRTC connection
    }

    /// Disconnect from the current tray session.
    func disconnect() {
        connectionState = .disconnected
        trayId = nil
        leaderConnected = false
        participantCount = 0
        connectedSince = nil
        // TODO: Tear down WebRTC / signaling
    }

    /// Clear all stored data (history, credentials, etc.)
    func clearStoredData() {
        joinUrlHistory = []
        UserDefaults.standard.removeObject(forKey: "joinUrlHistory")
        UserDefaults.standard.removeObject(forKey: "joinUrl")
    }

    /// Send a user message to the agent.
    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = ChatMessage(
            id: UUID().uuidString,
            role: .user,
            content: trimmed,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        messages.append(message)
        // TODO: Send message over WebRTC data channel to leader
    }

    /// Abort the current streaming response.
    func abort() {
        isStreaming = false
        // TODO: Send abort signal over WebRTC data channel
    }

    // MARK: - Private

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

