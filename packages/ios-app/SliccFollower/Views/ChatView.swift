import SwiftUI

struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @State private var inputText = ""
    @State private var showSettings = false

    private let background = Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255)

    var body: some View {
        VStack(spacing: 0) {
            // Connection status bar
            ConnectionStatusView(
                state: appState.connectionState,
                onTapDisconnected: { showSettings = true }
            )
            .animation(.easeInOut(duration: 0.3), value: appState.connectionState)

            // Message list (WebView)
            MessageWebView(
                messages: appState.messages,
                isStreaming: appState.isStreaming
            )
            .ignoresSafeArea(.keyboard)

            // Input bar
            InputBar(
                text: $inputText,
                isStreaming: appState.isStreaming,
                isConnected: appState.connectionState == .connected,
                onSend: { text in
                    appState.sendMessage(text)
                    inputText = ""
                },
                onAbort: {
                    appState.abort()
                }
            )
        }
        .background(background)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: { showSettings = true }) {
                    Image(systemName: "gearshape")
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(appState)
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        ChatView()
            .navigationTitle("SLICC")
            .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
    .environmentObject(AppState())
}

