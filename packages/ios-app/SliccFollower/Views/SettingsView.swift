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
            joinUrlHelpDisclosure
            connectDisconnectButton
            connectionStatusRow
        } header: {
            Text("Connection")
        } footer: {
            Text("The Join URL pairs this phone with a SLICC desktop browser so it can mirror the conversation.")
        }
    }

    /// Mirrors the webapp's "How do I get the sync URL?" disclosure
    /// (provider-settings.ts → renderJoinTrayForm). New users repeatedly
    /// hit the empty Join URL field with no idea where to find one;
    /// inline guidance points them at the desktop SLICC's avatar menu
    /// or the agent prompt that returns a tray URL.
    private var joinUrlHelpDisclosure: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                joinUrlStep(
                    number: 1,
                    text: "Open SLICC on your computer (Sliccstart, the Chrome extension, or the standalone CLI)."
                )
                joinUrlStep(
                    number: 2,
                    text: "Click your avatar in the top-right corner and choose **Enable multi-browser sync** — the Join URL is copied to your clipboard."
                )
                joinUrlStep(
                    number: 3,
                    text: "On the latest version you can also ask the agent: _“Run host for me and give me the tray join URL.”_"
                )
                joinUrlStep(
                    number: 4,
                    text: "Paste the URL into the **Join URL** field above. Both sides must be on the same SLICC version."
                )
            }
            .padding(.vertical, 4)
            .font(.footnote)
            .foregroundStyle(.secondary)
        } label: {
            Label("How do I get a Join URL?", systemImage: "questionmark.circle")
                .font(.subheadline)
        }
    }

    private func joinUrlStep(number: Int, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(number).")
                .font(.footnote.monospacedDigit().weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18, alignment: .trailing)
            // Inline markdown gives us **bold** + _italic_ rendering in
            // Form rows without dragging in the heavier MarkdownText path.
            Text((try? AttributedString(markdown: text)) ?? AttributedString(text))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
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