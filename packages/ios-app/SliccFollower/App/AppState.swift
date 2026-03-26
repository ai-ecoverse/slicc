import SwiftUI

/// Represents the current connection state of the follower app.
enum ConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
}

/// Placeholder for chat messages — will be fully defined later.
struct ChatMessage: Identifiable {
    let id = UUID()
    let role: String
    let content: String
    let timestamp: Date
}

/// Global app state shared across views via @EnvironmentObject.
@MainActor
class AppState: ObservableObject {
    @Published var connectionState: ConnectionState = .disconnected
    @Published var joinUrl: String = ""
    @Published var trayId: String?
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming: Bool = false
}

