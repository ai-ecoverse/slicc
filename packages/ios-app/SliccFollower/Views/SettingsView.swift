import SliccTrayKit
import SliccTraySession
import SwiftUI

struct SettingsView: View {
    private struct ThinkingOption: Identifiable {
        let id: String
        let label: String
    }

    private static let thinkingOptions = [
        ThinkingOption(id: "off", label: "Off"),
        ThinkingOption(id: "low", label: "Low"),
        ThinkingOption(id: "medium", label: "Medium"),
        ThinkingOption(id: "high", label: "High"),
        ThinkingOption(id: "xhigh", label: "Extra High"),
        ThinkingOption(id: "max", label: "Max"),
    ]

    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @AppStorage("leftHandedDock") private var leftHandedDock = false
    
    
    @AppStorage("openLinksInBuiltInBrowser") private var openLinksInBuiltInBrowser = true
    
    
    
    @State private var now = Date()
    
    
    
    @State private var awaitingConnect = false
    
    
    
    
    
    
    @State private var hasICloudIdentity: Bool?
    
    
    @State private var reachability = SessionReachability()
    private let staleTicker = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            Form {
                iCloudSessionsSection
                if !recentRows.isEmpty { recentSessionsSection }
                connectionSection
                speechSection
                if appState.connectionState == .connected {
                    if appState.supportsModelControls {
                        modelSection
                    }
                    trayInfoSection
                }
                openGrantsSection
                advancedSection
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                appState.refreshModels()
            }
            .task {
                hasICloudIdentity = await Self.probeICloudIdentity()
            }
            
            
            .onChange(of: appState.connectionState) { _, state in
                guard awaitingConnect else { return }
                if state == .connected {
                    awaitingConnect = false
                    dismiss()
                } else if state == .disconnected || state == .failed || state == .gaveUp {
                    
                    
                    awaitingConnect = false
                }
            }
        }
    }

    

    private var modelSection: some View {
        Section {
            if appState.modelCatalog.isEmpty {
                LabeledContent(
                    "Model",
                    value: appState.modelSelectionState?.activeModelId ?? "Loading…")
            } else {
                Picker("Model", selection: modelSelection) {
                    ForEach(appState.modelCatalog) { model in
                        Text("\(model.modelName) · \(model.providerName)")
                            .tag(model.modelId)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("model-picker")
            }

            if appState.activeModel?.reasoning == true {
                Picker("Thinking", selection: thinkingSelection) {
                    ForEach(Self.thinkingOptions) { option in
                        Text(option.label).tag(option.id)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("thinking-picker")
            }
        } header: {
            Text("Model & Thinking")
        } footer: {
            Text("Model selection is global. Thinking applies only to the currently selected scoop.")
        }
        .onAppear { appState.refreshModels() }
    }

    private var modelSelection: Binding<String> {
        Binding(
            get: { appState.modelSelectionState?.activeModelId ?? "" },
            set: { appState.selectModel($0) })
    }

    private var thinkingSelection: Binding<String> {
        Binding(
            get: { appState.displayedThinkingLevel },
            set: { appState.setThinkingLevel($0) })
    }

    

    
    
    
    
    private var iCloudSessionsSection: some View {
        Section {
            let rows = sessionRowsSortedByReachability
            if rows.isEmpty {
                sessionsEmptyState
            } else {
                ForEach(rows, id: \.session.id) { row in
                    sessionRow(row.session, deviceName: row.deviceName)
                }
            }
        } header: {
            Text("iCloud Sessions")
        } footer: {
            Text("Sessions started with Sliccstart on your other devices appear automatically.")
        }
        .onAppear {
            appState.sessionStore.reload()
            appState.recentJoinStore.reload()
            now = Date()
            reachability.probe(appState.sessionStore.sessions)
            reachability.probe(appState.recentJoinStore.recents)
        }
        
        
        
        
        
        
        .onChange(of: appState.sessionStore.sessions) { _, sessions in
            reachability.probe(sessions)
        }
        .onChange(of: appState.recentJoinStore.recents) { _, recents in
            reachability.probe(recents)
        }
        .onReceive(staleTicker) { now = $0 }
    }

    
    
    
    private var sessionRowsSortedByReachability: [(session: SyncedTraySession, deviceName: String)] {
        ICloudSessionList.groups(from: appState.sessionStore.sessions)
            .flatMap { group in
                group.sessions.map { (session: $0, deviceName: group.deviceName) }
            }
            .sorted { a, b in
                let aReachable = reachability.presumedReachable(a.session.id)
                let bReachable = reachability.presumedReachable(b.session.id)
                if aReachable != bReachable { return aReachable }
                return a.session.lastSeenAt > b.session.lastSeenAt
            }
    }

    private func sessionRow(_ session: SyncedTraySession, deviceName: String) -> some View {
        Button {
            
            
            guard !session.isStale(ttl: TraySessionSyncStore.defaultTTL, now: Date()) else {
                appState.sessionStore.reload()
                return
            }
            awaitingConnect = true
            appState.connectToDiscoveredSession(
                joinUrl: session.joinUrl,
                displayName: session.label.isEmpty ? nil : session.label)
        } label: {
            let unreachable = reachability.verdicts[session.id] == .unreachable
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.label.isEmpty ? "Sliccy session" : session.label)
                        .foregroundStyle(.primary)
                    Text(
                        "\(deviceName) · \(ICloudSessionList.age(of: session.lastSeenAt, now: now))"
                            + (unreachable ? " · not responding" : "")
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: unreachable ? "icloud.slash" : "arrow.right.circle")
                    .foregroundStyle(unreachable ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
            }
            .opacity(unreachable ? 0.55 : 1)
        }
        
        .accessibilityIdentifier("icloud-session-\(session.id)")
        .disabled(
            session.isStale(ttl: TraySessionSyncStore.defaultTTL, now: now)
                || appState.connectionState == .connecting
        )
    }

    private var sessionsEmptyState: some View {
        
        
        
        let reason = ICloudSessionList.emptyReason(
            hasICloudIdentity: hasICloudIdentity ?? true
        )
        return HStack(spacing: 10) {
            Image(systemName: reason == .iCloudUnavailable ? "icloud.slash" : "icloud")
                .foregroundStyle(.secondary)
            Text(
                reason == .iCloudUnavailable
                    ? "Sign in to iCloud to see sessions from your other devices."
                    : "No active sessions."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("icloud-sessions-empty")
    }

    
    
    private static func probeICloudIdentity() async -> Bool {
        await Task.detached(priority: .userInitiated) {
            FileManager.default.ubiquityIdentityToken != nil
        }.value
    }

    

    
    
    
    private var recentSessionsSection: some View {
        Section {
            ForEach(recentRows) { recent in
                recentRow(recent)
            }
        } header: {
            Text("Recent")
        } footer: {
            Text("Sessions you have connected to before, on this device or your others.")
        }
    }

    
    
    
    private var recentRows: [RecentJoin] {
        ICloudSessionList.recentRows(
            from: appState.recentJoinStore.recents,
            excluding: appState.sessionStore.sessions,
            isReachable: { reachability.presumedReachable($0) })
    }

    private func recentRow(_ recent: RecentJoin) -> some View {
        let unreachable = reachability.verdicts[recent.id] == .unreachable
        return Button {
            awaitingConnect = true
            
            
            appState.connectToDiscoveredSession(
                joinUrl: recent.joinUrl,
                displayName: recent.label.isEmpty ? nil : recent.label)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ICloudSessionList.recentTitle(recent))
                        .foregroundStyle(.primary)
                    Text(
                        ICloudSessionList.recentSubtitle(
                            recent,
                            thisDeviceId: appState.recentJoinStore.deviceId,
                            now: now,
                            unreachable: unreachable)
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: unreachable ? "clock.arrow.circlepath" : "arrow.right.circle")
                    .foregroundStyle(unreachable ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
            }
            .opacity(unreachable ? 0.55 : 1)
        }
        
        .accessibilityIdentifier("recent-session-\(recent.id)")
        .disabled(appState.connectionState == .connecting)
        .swipeActions(edge: .trailing) {
            
            
            Button("Remove", role: .destructive) {
                appState.recentJoinStore.forget(id: recent.id)
            }
        }
    }

    

    private var connectionSection: some View {
        Section {
            HStack {
                TextField("Join link", text: $appState.joinUrl)
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
            connectActionRow
            connectionNote
        } header: {
            Text("Connection")
        } footer: {
            Text("Connect to a Sliccy session with its join link.")
        }
    }

    
    
    @ViewBuilder
    private var connectActionRow: some View {
        switch appState.connectionState {
        case .connected:
            Button("Disconnect", role: .destructive) {
                appState.disconnect()
            }
        case .reconnecting:
            
            
            
            Button("Stop Reconnecting", role: .destructive) {
                appState.disconnect()
            }
        case .connecting:
            HStack(spacing: 10) {
                ProgressView()
                Text("Connecting…")
                    .foregroundStyle(.secondary)
            }
        case .disconnected, .failed, .gaveUp:
            Button(connectionAttemptFailed ? "Retry" : "Connect") {
                awaitingConnect = true
                appState.connect()
            }
            .disabled(
                appState.joinUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
        }
    }

    private var connectionAttemptFailed: Bool {
        appState.connectionState == .failed || appState.connectionState == .gaveUp
    }

    
    
    
    @ViewBuilder
    private var connectionNote: some View {
        switch appState.connectionState {
        case .connected:
            HStack(spacing: 8) {
                Circle().fill(.green).frame(width: 8, height: 8)
                Text("Connected").foregroundStyle(.secondary)
            }
        case .reconnecting:
            HStack(spacing: 8) {
                Circle().fill(.orange).frame(width: 8, height: 8)
                Text("Reconnecting…").foregroundStyle(.secondary)
            }
        case .failed, .gaveUp:
            HStack(spacing: 8) {
                Circle().fill(.red).frame(width: 8, height: 8)
                Text(appState.lastError ?? "Couldn't connect. Check the join link and try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .disconnected, .connecting:
            EmptyView()
        }
    }

    
    
    
    
    
    private var joinUrlHelpDisclosure: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                joinUrlStep(
                    number: 1,
                    text: "Open Sliccy on your computer (Sliccstart, the Chrome extension, or the standalone CLI)."
                )
                joinUrlStep(
                    number: 2,
                    text: "Click your avatar in the top-right corner and choose **Enable multi-browser sync** — the join link is copied to your clipboard."
                )
                joinUrlStep(
                    number: 3,
                    text: "On the latest version you can also ask the agent: _“Run host for me and give me the tray join link.”_"
                )
                joinUrlStep(
                    number: 4,
                    text: "Paste it into the **Join link** field above. Both sides must be on the same Sliccy version."
                )
            }
            .padding(.vertical, 4)
            .font(.footnote)
            .foregroundStyle(.secondary)
        } label: {
            Label("How do I get a join link?", systemImage: "questionmark.circle")
                .font(.subheadline)
        }
    }

    private func joinUrlStep(number: Int, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(number).")
                .font(.footnote.monospacedDigit().weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18, alignment: .trailing)
            
            
            Text((try? AttributedString(markdown: text)) ?? AttributedString(text))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    

    private var speechSection: some View {
        SpeechSettingsSection()
    }

    

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

    

    private var openGrantsSection: some View {
        Section {
            if appState.openGrants.isEmpty {
                Text("No stored open grants")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(appState.openGrants) { grant in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(grant.scope.scheme)
                            Text(Self.grantDestination(grant.scope))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Revoke", role: .destructive) {
                            appState.revokeOpenGrant(id: grant.id)
                        }
                        .accessibilityIdentifier("open-grant-revoke-\(grant.id.uuidString)")
                    }
                }
                Button("Revoke All Open Grants", role: .destructive) {
                    appState.revokeAllOpenGrants()
                }
            }
        } header: {
            Text("Allowed App Destinations")
        } footer: {
            Text("Grants stay on this phone and match only the displayed scheme and destination prefix.")
        }
    }

    private static func grantDestination(_ scope: OpenGrantScope) -> String {
        if scope.authority.isEmpty { return scope.actionPrefix }
        if scope.actionPrefix.isEmpty { return scope.authority }
        return scope.authority + "/" + scope.actionPrefix
    }

    

    private var advancedSection: some View {
        Section {
            Toggle("Auto-reconnect", isOn: $appState.autoReconnect)

            
            
            Toggle("Left-handed dock", isOn: $leftHandedDock)

            Toggle("Open links in Sliccy", isOn: $openLinksInBuiltInBrowser)
                .accessibilityIdentifier("open-links-in-app-toggle")

            Button("Clear Stored Data", role: .destructive) {
                appState.clearStoredData()
            }
        } header: {
            Text("Advanced")
        } footer: {
            Text(
                "Links in the conversation open as tabs in Sliccy's browser. "
                    + "Turn that off to hand them to your default browser instead.")
        }
    }
}

private struct SpeechSettingsSection: View {
    @StateObject private var kokoroModels = KokoroModelInstallation.shared
    
    
    
    @State private var now = Date()
    private let etaTicker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Section {
            if case .notInstalled = kokoroModels.state {
                
                
                
                Button("Download High-Quality English Voice") {
                    kokoroModels.requestInstallation()
                }
                .accessibilityIdentifier("kokoro-install-toggle")
            }

            kokoroInstallationStatus
        } header: {
            Text("Speech")
        }
        .onReceive(etaTicker) { tick in
            
            
            
            if case .downloading = kokoroModels.state { now = tick }
        }
    }

    @ViewBuilder
    private var kokoroInstallationStatus: some View {
        switch kokoroModels.state {
        case .notInstalled:
            Text("83 MB. Downloads over Wi-Fi only.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("kokoro-install-status")
        case .downloading(let fraction):
            ProgressView(value: fraction)
                .accessibilityIdentifier("kokoro-download-progress")
            Text(downloadStatusLine(fraction: fraction))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("kokoro-install-status")
            Button("Cancel Download", role: .destructive) { kokoroModels.cancelDownload() }
                .accessibilityIdentifier("kokoro-download-cancel")
        case .installed:
            Text(
                kokoroModels.usesDeveloperPack
                    ? "Installed from SLICC_KOKORO_MODELS_DIR."
                    : "Installed · about 83 MB"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("kokoro-install-status")
            
            
            Button("Play a Short Sample") {
                VoiceReply.shared.speakReply(
                    markdown: "<!--lang:en-->Kokoro is installed and speaking.")
            }
            .accessibilityIdentifier("kokoro-install-preview")
            if !kokoroModels.usesDeveloperPack {
                Button("Remove Download", role: .destructive) {
                    kokoroModels.removeInstallation()
                }
                .accessibilityIdentifier("kokoro-install-remove")
            }
        case .failed(let error):
            Text(error.localizedDescription)
                .font(.footnote)
                .foregroundStyle(.red)
                .accessibilityIdentifier("kokoro-install-failure")
            Text("Replies continue with the system voice.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("kokoro-install-status")
            Button("Retry Download") { kokoroModels.requestInstallation() }
                .accessibilityIdentifier("kokoro-install-retry")
        }
    }

    
    
    
    
    private func downloadStatusLine(fraction: Double) -> String {
        var line = "Downloading · \(Int(fraction * 100))%"
        if let started = kokoroModels.downloadStartedAt, fraction >= 0.05, fraction < 1 {
            let elapsed = now.timeIntervalSince(started)
            let remaining = elapsed * (1 - fraction) / fraction
            if remaining.isFinite, remaining > 0 {
                line += " · About \(Self.roundedETA(seconds: remaining)) remaining"
            }
        }
        return line
    }

    private static func roundedETA(seconds: Double) -> String {
        if seconds >= 90 {
            let minutes = Int((seconds / 60).rounded())
            return minutes == 1 ? "1 minute" : "\(minutes) minutes"
        }
        
        return "\(max(10, Int((seconds / 10).rounded()) * 10)) seconds"
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppState())
}
