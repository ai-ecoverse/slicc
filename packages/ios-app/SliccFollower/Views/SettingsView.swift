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
    /// Mirrors `ChatView`: transcript links open as local browser tabs
    /// unless the user hands them back to the system browser.
    @AppStorage("openLinksInBuiltInBrowser") private var openLinksInBuiltInBrowser = true
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
    /// Sinks sessions whose leader no longer answers to the bottom of the
    /// iCloud list (KVS keeps advertising them past the leader's death).
    @State private var reachability = SessionReachability()
    private let staleTicker = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            Form {
                iCloudSessionsSection
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

    // MARK: - Model Section

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

    // MARK: - iCloud Sessions Section

    /// Live leaders other devices on this Apple ID advertised to iCloud.
    /// Tapping one threads its join URL into the normal connect path — the
    /// URL carries the session secret, so it is never rendered, logged, or
    /// used in an accessibility identifier (rows use the one-way session id).
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
            now = Date()
            reachability.probe(appState.sessionStore.sessions)
        }
        .onReceive(staleTicker) { now = $0 }
    }

    /// Flattened device groups, reachable (or not-yet-probed) sessions first,
    /// each cohort newest-first. Unreachable rows keep rendering — the probe
    /// can be wrong about a flaky network — but sink below the live ones.
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
            // Revalidate at tap time: the row's disabled state was computed at
            // render time, and a session can age out in between.
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
                    ? "Sign in to iCloud to see sessions from your other devices."
                    : "No active sessions."
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
            connectActionRow
            connectionNote
        } header: {
            Text("Connection")
        } footer: {
            Text("Connect to a Sliccy session with its Join URL.")
        }
    }

    /// A plain action row, styled like Cancel Download and Clear Stored
    /// Data — just blue instead of red (review note on the first draft).
    @ViewBuilder
    private var connectActionRow: some View {
        switch appState.connectionState {
        case .connected:
            Button("Disconnect", role: .destructive) {
                appState.disconnect()
            }
        case .reconnecting:
            // Same full teardown as Disconnect (reconnect budget, stored
            // credentials, file-provider domain) — the label says what the
            // tap actually abandons.
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

    /// Status appears only when it says something: an in-flight reconnect, a
    /// live connection, or why the last attempt failed. An idle sheet shows
    /// no "Disconnected" row for a connection nobody has started.
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
                Text(appState.lastError ?? "Couldn't connect. Check the Join URL and try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .disconnected, .connecting:
            EmptyView()
        }
    }

    /// Mirrors the webapp's "How do I get the sync URL?" disclosure
    /// (provider-settings.ts → renderJoinTrayForm). New users repeatedly
    /// hit the empty Join URL field with no idea where to find one;
    /// inline guidance points them at the desktop Sliccy's avatar menu
    /// or the agent prompt that returns a tray URL.
    private var joinUrlHelpDisclosure: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                joinUrlStep(
                    number: 1,
                    text: "Open Sliccy on your computer (Sliccstart, the Chrome extension, or the standalone CLI)."
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
                    text: "Paste the URL into the **Join URL** field above. Both sides must be on the same Sliccy version."
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

    // MARK: - Speech Section

    private var speechSection: some View {
        SpeechSettingsSection()
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

    // MARK: - Open Grants Section

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

    // MARK: - Advanced Section

    private var advancedSection: some View {
        Section {
            Toggle("Auto-reconnect", isOn: $appState.autoReconnect)

            // Mirrors the dock rail to the leading edge (#1864) — thumb
            // reachability is a hand-dominance question, not a layout one.
            Toggle("Left-handed dock", isOn: $leftHandedDock)

            Toggle("Open links in Sliccy", isOn: $openLinksInBuiltInBrowser)
                .accessibilityIdentifier("open-links-in-app-toggle")

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
    /// Re-samples the ETA once a second while a download runs; progress
    /// callbacks alone can stall for seconds on a slow link and let a
    /// stale "about 10 s left" sit on screen.
    @State private var now = Date()
    private let etaTicker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Section {
            if case .notInstalled = kokoroModels.state {
                // One tap starts the download; the label already discloses
                // the size and Wi-Fi-only behavior, so there is no second
                // confirm step — just Cancel + ETA once it runs.
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
            // Only invalidate the section while an ETA is actually on
            // screen; a 1 Hz re-render of an idle sheet shows up in
            // Instruments (review finding).
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
            // Routes through the same VoiceReply path a dictated reply takes,
            // so a silent Kokoro path surfaces here instead of in dictation.
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

    /// "Downloading · 42% · About 40 seconds remaining" — Apple's download
    /// phrasing. The ETA extrapolates from elapsed wall-clock and completed
    /// fraction; it only appears once 5% is in, because earlier
    /// extrapolations swing wildly.
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
        // Sub-90s counts in tens of seconds so the number does not flicker.
        return "\(max(10, Int((seconds / 10).rounded()) * 10)) seconds"
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppState())
}
