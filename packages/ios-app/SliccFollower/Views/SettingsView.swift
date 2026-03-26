import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @AppStorage("joinUrl") private var storedJoinUrl: String = ""

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                if appState.connectionState == .connected {
                    trayInfoSection
                }
                advancedSection
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if appState.joinUrl.isEmpty, !storedJoinUrl.isEmpty {
                    appState.joinUrl = storedJoinUrl
                }
                if let history = UserDefaults.standard.stringArray(forKey: "joinUrlHistory") {
                    appState.joinUrlHistory = history
                }
            }
            .onChange(of: appState.joinUrl) { _, newValue in
                storedJoinUrl = newValue
            }
        }
    }

    // MARK: - Connection Section

    private var connectionSection: some View {
        Section {
            HStack {
                TextField("Join URL", text: $appState.joinUrl)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                Button {
                    if let string = UIPasteboard.general.string {
                        appState.joinUrl = string
                    }
                } label: {
                    Image(systemName: "doc.on.clipboard")
                }
                .buttonStyle(.borderless)
            }
            // TODO: Implement QR code scanner using DataScannerViewController (iOS 16+)
            Button {
                // QR scanning not yet implemented
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
            }
            connectDisconnectButton
            connectionStatusRow
        } header: {
            Text("Connection")
        }
    }

    private var connectDisconnectButton: some View {
        Group {
            if appState.connectionState == .connected || appState.connectionState == .reconnecting {
                Button(role: .destructive) {
                    appState.disconnect()
                } label: {
                    HStack {
                        Spacer()
                        Text("Disconnect").fontWeight(.semibold)
                        Spacer()
                    }
                }
            } else {
                Button {
                    appState.connect()
                } label: {
                    HStack {
                        Spacer()
                        Text("Connect").fontWeight(.semibold)
                        Spacer()
                    }
                }
                .disabled(
                    appState.joinUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || appState.connectionState == .connecting
                )
                .tint(.purple)
            }
        }
    }

    private var connectionStatusRow: some View {
        HStack {
            Text("Status")
            Spacer()
            Circle()
                .fill(connectionDotColor)
                .frame(width: 8, height: 8)
            Text(connectionStatusText)
                .foregroundStyle(.secondary)
        }
    }

    private var connectionDotColor: Color {
        switch appState.connectionState {
        case .disconnected, .failed: .red
        case .connecting: .yellow
        case .connected: .green
        case .reconnecting: .orange
        }
    }

    private var connectionStatusText: String {
        switch appState.connectionState {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting…"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting…"
        case .failed: "Failed"
        }
    }

    // MARK: - Tray Info Section

    private var trayInfoSection: some View {
        Section {
            if let trayId = appState.trayId {
                LabeledContent("Tray ID", value: trayId)
            }
            LabeledContent("Leader") {
                Text(appState.leaderConnected ? "Connected" : "Disconnected")
                    .foregroundStyle(appState.leaderConnected ? .green : .red)
            }
            LabeledContent("Participants", value: "\(appState.participantCount)")
            if let since = appState.connectedSince {
                LabeledContent("Connected Since") {
                    Text(since.formatted(date: .abbreviated, time: .shortened))
                }
            }
        } header: {
            Text("Tray Info")
        }
    }


    // MARK: - Advanced Section

    private var advancedSection: some View {
        Section {
            Toggle("Auto-reconnect", isOn: $appState.autoReconnect)

            if !appState.joinUrlHistory.isEmpty {
                DisclosureGroup("Recent URLs") {
                    ForEach(appState.joinUrlHistory, id: \.self) { url in
                        Button {
                            appState.joinUrl = url
                        } label: {
                            Text(url)
                                .font(.caption)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }

            Button("Clear Stored Data", role: .destructive) {
                appState.clearStoredData()
                storedJoinUrl = ""
            }
        } header: {
            Text("Advanced")
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppState())
}