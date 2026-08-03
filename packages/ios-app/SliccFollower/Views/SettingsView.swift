import SliccTraySession
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @AppStorage("joinUrl") private var storedJoinUrl: String = ""
    @AppStorage("leftHandedDock") private var leftHandedDock = false
    /// Re-evaluates session staleness and ages while the sheet stays open —
    /// without it, `Date()` in `body` is only sampled on unrelated redraws and
    /// a row crossing the 12h TTL would stay enabled indefinitely.
    @State private var now = Date()
    /// Set when the user asks THIS sheet to connect, so the auto-dismiss only
    /// fires for a connection they just started here. Opening Settings while
    /// a background reconnect happens to land must not yank the sheet away.
    @State private var awaitingConnect = false
    /// Whether this device has an iCloud identity, or nil while unknown.
    ///
    /// `FileManager.ubiquityIdentityToken` reaches the iCloud daemon and can
    /// block; reading it inside `body` put that call on the main thread on
    /// every single layout pass of the sheet. It is sampled once, off the
    /// main actor, and the answer cannot change while the sheet is open.
    @State private var hasICloudIdentity: Bool?
    private let staleTicker = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            Form {
                iCloudSessionsSection
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
            .task {
                hasICloudIdentity = await Self.probeICloudIdentity()
            }
            .onChange(of: appState.joinUrl) { _, newValue in
                storedJoinUrl = newValue
            }
            // Connecting is the reason the sheet was opened; once it lands,
            // the settings form is in the way of the conversation.
            .onChange(of: appState.connectionState) { _, state in
                guard awaitingConnect else { return }
                if state == .connected {
                    awaitingConnect = false
                    dismiss()
                } else if state == .disconnected || state == .failed || state == .gaveUp {
                    // The attempt resolved without connecting — stay put so
                    // the error is readable and the URL can be corrected.
                    awaitingConnect = false
                }
            }
        }
    }

    // MARK: - iCloud Sessions Section

    /// Live leaders other devices on this Apple ID advertised to iCloud.
    /// Tapping one threads its join URL into the normal connect path — the
    /// URL carries the session secret, so it is never rendered, logged, or
    /// used in an accessibility identifier (rows use the one-way session id).
    private var iCloudSessionsSection: some View {
        Section {
            let groups = ICloudSessionList.groups(from: appState.sessionStore.sessions)
            if groups.isEmpty {
                sessionsEmptyState
            } else {
                ForEach(groups) { group in
                    ForEach(group.sessions) { session in
                        sessionRow(session, deviceName: group.deviceName)
                    }
                }
            }
        } header: {
            Text("iCloud Sessions")
        } footer: {
            Text(
                "Leaders started with Sliccstart on this Apple ID appear here "
                    + "automatically. Others (cloud, another Apple ID) still join via a "
                    + "pasted Join URL below."
            )
        }
        .onAppear {
            appState.sessionStore.reload()
            now = Date()
        }
        .onReceive(staleTicker) { now = $0 }
    }

    private func sessionRow(_ session: SyncedTraySession, deviceName: String) -> some View {
        Button {
            // Revalidate at tap time: the row's disabled state was computed at
            // render time, and a session can age out in between.
            guard !session.isStale(ttl: TraySessionSyncStore.defaultTTL, now: Date()) else {
                appState.sessionStore.reload()
                return
            }
            awaitingConnect = true
            appState.connectToDiscoveredSession(joinUrl: session.joinUrl)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.label.isEmpty ? "SLICC session" : session.label)
                        .foregroundStyle(.primary)
                    Text("\(deviceName) · \(ICloudSessionList.age(of: session.lastSeenAt, now: now))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "arrow.right.circle")
                    .foregroundStyle(.tint)
            }
        }
        // The one-way hash, deliberately — never the join URL.
        .accessibilityIdentifier("icloud-session-\(session.id)")
        .disabled(
            session.isStale(ttl: TraySessionSyncStore.defaultTTL, now: now)
                || appState.connectionState == .connecting
        )
    }

    private var sessionsEmptyState: some View {
        // `hasICloudIdentity` is sampled off the main actor (see its
        // declaration); until it answers, assume iCloud is fine so the row
        // cannot flash "iCloud is unavailable" at someone who is signed in.
        let reason = ICloudSessionList.emptyReason(
            hasICloudIdentity: hasICloudIdentity ?? true
        )
        return HStack(spacing: 10) {
            Image(systemName: reason == .iCloudUnavailable ? "icloud.slash" : "icloud")
                .foregroundStyle(.secondary)
            Text(
                reason == .iCloudUnavailable
                    ? "iCloud is unavailable on this device. Sign in to iCloud, or paste a Join URL below."
                    : "No active sessions. Start a leader with Sliccstart on a Mac using this Apple ID, or paste a Join URL below."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("icloud-sessions-empty")
    }

    /// Off the main actor: the token read can block on the iCloud daemon,
    /// and nothing about the sheet needs it synchronously.
    private static func probeICloudIdentity() async -> Bool {
        await Task.detached(priority: .userInitiated) {
            FileManager.default.ubiquityIdentityToken != nil
        }.value
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
                    awaitingConnect = true
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
        case .disconnected, .failed, .gaveUp: .red
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
        case .gaveUp: "Gave up"
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

            // Mirrors the dock rail to the leading edge (#1864) — thumb
            // reachability is a hand-dominance question, not a layout one.
            Toggle("Left-handed dock", isOn: $leftHandedDock)

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
