import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "Settings")

/// UserDefaults key for the auto-launch browser. The value is the
/// `AppTarget.id` (bundle path) of the browser, or an empty string for
/// "None". Read at app startup by `SliccstartApp.initialize`.
let autoLaunchAppIdKey = "autoLaunchAppId"

/// UserDefaults keys shared with the terminal launch flow.
let terminalFollowCommandKey = "terminalFollowCommand"
let suppressTerminalWarningKey = "suppressTerminalWarning"

/// Validation rules for secret names entered in the Settings → Secrets
/// editor. Accepted set: `^[a-zA-Z0-9._-]+$` (ASCII letters/digits plus
/// dot, underscore, hyphen, non-empty). Mount-profile keys use the shape
/// `s3.<profile>.<field>` (dots), and tokens are commonly named with
/// hyphens (e.g. `gh-prod`).
///
/// **Must stay byte-for-byte identical with `SignAndForward.isValidProfileName`
/// in `packages/swift-server/Sources/Server/SignAndForward.swift`.** The UI
/// saves names that the server later validates on every signed request;
/// any character the UI accepts that the server rejects becomes a
/// post-save failure that surfaces as `400 invalid_profile` on each mount
/// call rather than as inline feedback. We therefore explicitly enumerate
/// ASCII bytes rather than using `CharacterSet.alphanumerics`, which is
/// Unicode-broad and would silently accept e.g. Cyrillic homoglyphs that
/// the server rejects.
///
/// Lives at file scope (not nested inside the private `SecretEditorSheet`)
/// so unit tests can reach it via `@testable import Sliccstart`.
enum SecretNameValidator {
    static func isValid(_ name: String) -> Bool {
        guard !name.isEmpty else { return false }
        for scalar in name.unicodeScalars {
            let v = scalar.value
            let alpha = (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
            let digit = v >= 0x30 && v <= 0x39
            let punct = v == 0x2E || v == 0x5F || v == 0x2D  // . _ -
            if !(alpha || digit || punct) { return false }
        }
        return true
    }
}

struct SettingsView: View {
    var fileProviderCoordinator: FileProviderCoordinator

    var body: some View {
        TabView {
            StartupSettingsView(fileProviderCoordinator: fileProviderCoordinator)
                .tabItem { Label("Startup", systemImage: "power") }
            TerminalsSettingsView()
                .tabItem { Label("Terminals", systemImage: "terminal") }
            SecretsSettingsView()
                .tabItem { Label("Secrets", systemImage: "key.fill") }
        }
    }
}

// MARK: - Startup tab

struct StartupSettingsView: View {
    var fileProviderCoordinator: FileProviderCoordinator
    @AppStorage(StartupPreference.enabledKey) private var launchAtStartup = false
    @State private var topBrowserName: String?
    @State private var isDefaultBrowser = false
    @State private var isRequestingDefaultBrowser = false

    var body: some View {
        Form {
            Toggle(isOn: $launchAtStartup) {
                if let topBrowserName {
                    Text("Launch \(topBrowserName) on startup")
                } else {
                    Text("Launch top browser on startup")
                }
            }
            Text("Launches the browser at the top of your Browsers list. Drag to reorder that list in the main window to change which one starts.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Divider()
            Toggle(
                isOn: Binding(
                    get: { fileProviderCoordinator.isEnabled },
                    set: { fileProviderCoordinator.isEnabled = $0 }
                )
            ) {
                Text("Show leader files in Finder")
            }
            .accessibilityIdentifier("finder-file-provider")
            Text(
                "Mounts the leader workspace under Finder → Locations as \"Sliccy\". "
                    + "Enable the extension once in System Settings → Login Items & Extensions → File Provider. "
                    + "The mount is only available while a leader is running."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            // Only offered alongside auto-launch: as the default browser
            // Sliccstart hands every link to the leader browser, so without a
            // leader waiting at startup the links would have nowhere to go.
            // Still shown once the role is held, so turning auto-launch back
            // off never hides the fact that Sliccstart owns web links.
            if launchAtStartup || isDefaultBrowser {
                Divider()
                defaultBrowserSection
            }
        }
        .padding(20)
        .frame(width: 460)
        .fixedSize()
        .onAppear {
            StartupPreference.resolveEnabled(defaults: .standard)
            topBrowserName =
                AppOrdering.topBrowser(
                    in: AppScanner.scan(hasAppManagementPermission: false),
                    savedOrder: AppOrderStore().load(AppOrderStore.browserKey)
                )?.name
            isDefaultBrowser = DefaultBrowserRegistration.isDefault()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // The role can also change in System Settings, or through the
            // macOS confirmation panel we can't observe directly.
            isDefaultBrowser = DefaultBrowserRegistration.isDefault()
        }
    }

    @ViewBuilder
    private var defaultBrowserSection: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Default web browser")
                Text(defaultBrowserCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(isDefaultBrowser ? "Enabled" : "Make Default") {
                Task {
                    isRequestingDefaultBrowser = true
                    isDefaultBrowser = await DefaultBrowserRegistration.makeDefault()
                    isRequestingDefaultBrowser = false
                }
            }
            .disabled(isDefaultBrowser || isRequestingDefaultBrowser || !DefaultBrowserRegistration.isRegistrable)
            .accessibilityIdentifier("make-default-browser")
        }
    }

    private var defaultBrowserCaption: String {
        if isDefaultBrowser {
            return "Links from other apps open as tabs in your SLICC browser session."
        }
        if !DefaultBrowserRegistration.isRegistrable {
            return "Available in the installed Sliccstart.app — this build runs from a source checkout."
        }
        return "Sliccstart takes over web links and opens each one in the SLICC browser, starting it first if needed. macOS will ask you to confirm."
    }
}

// MARK: - Terminals tab

struct TerminalsSettingsView: View {
    @AppStorage(terminalFollowCommandKey) private var followCommand = FollowCommandTemplate.defaultTemplate
    @AppStorage(suppressTerminalWarningKey) private var suppressTerminalWarning = false

    private static let placeholders: [(token: String, help: String)] = [
        ("{slicc}", "Path to the slicc CLI"),
        ("{joinUrl}", "Session join URL"),
        ("{shell}", "Login shell"),
    ]

    private var preview: String {
        FollowCommandTemplate.preview(
            template: followCommand,
            sliccPath: "/path/to/slicc",
            shellPath: LoginShellResolver.resolve()
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 16) {
                GridRow(alignment: .top) {
                    Text("Command")
                        .gridColumnAlignment(.trailing)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 8) {
                        TextField(
                            "Command",
                            text: $followCommand,
                            prompt: Text(FollowCommandTemplate.defaultTemplate),
                            axis: .vertical
                        )
                        .font(.system(.body, design: .monospaced))
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(2...4)
                        .disableAutocorrection(true)
                        .accessibilityLabel("Command")
                        .accessibilityIdentifier("follow-command-template")
                        placeholderLegend
                    }
                }
                GridRow(alignment: .top) {
                    Text("Preview")
                        .gridColumnAlignment(.trailing)
                        .padding(.top, 6)
                    previewWell
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            Divider()

            HStack(spacing: 6) {
                Button("Restore Default") {
                    followCommand = FollowCommandTemplate.defaultTemplate
                }
                .disabled(followCommand == FollowCommandTemplate.defaultTemplate)
                .help("Reset the command to the default template")
                .accessibilityIdentifier("restore-follow-command")

                Spacer()

                Button("Show Warning Again") {
                    suppressTerminalWarning = false
                }
                .disabled(!suppressTerminalWarning)
                .help("Show the terminal access warning the next time you follow a session")
                .accessibilityIdentifier("show-terminal-warning-again")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .frame(width: 620, height: 420)
    }

    private var placeholderLegend: some View {
        HStack(spacing: 6) {
            ForEach(Self.placeholders, id: \.token) { item in
                FollowCommandPlaceholderChip(token: item.token, help: item.help)
            }
            Spacer(minLength: 0)
        }
    }

    private var previewWell: some View {
        ScrollView {
            Text(preview)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity, alignment: .topLeading)
        .padding(10)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
        .accessibilityIdentifier("follow-command-preview")
    }
}

private struct FollowCommandPlaceholderChip: View {
    let token: String
    let help: String

    var body: some View {
        Text(token)
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .help(help)
            .accessibilityLabel(help)
            .accessibilityValue(token)
    }
}

// MARK: - Secrets tab

struct SecretsSettingsView: View {
    @State private var secrets: [Secret] = []
    @State private var unlocked = false
    @State private var selection: Secret.ID?
    @State private var editorDraft: SecretDraft?
    @State private var deletionTarget: Secret?
    @State private var errorMessage: String?

    /// Decorative rows shown blurred behind the unlock prompt before the
    /// user has authorised Keychain access. Real values are never used.
    private static let placeholders: [Secret] = [
        Secret(name: "GITHUB_TOKEN", value: "******", domains: ["api.github.com"]),
        Secret(name: "OPENAI_API_KEY", value: "******", domains: ["api.openai.com"]),
        Secret(name: "ANTHROPIC_API_KEY", value: "******", domains: ["api.anthropic.com"]),
        Secret(name: "AWS_SECRET_ACCESS_KEY", value: "******", domains: ["*.amazonaws.com"]),
        Secret(name: "SLACK_BOT_TOKEN", value: "******", domains: ["slack.com"]),
        Secret(name: "STRIPE_SECRET_KEY", value: "******", domains: ["api.stripe.com"]),
    ]

    private var displayedSecrets: [Secret] {
        unlocked ? secrets : Self.placeholders
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                table
                    .blur(radius: unlocked ? 0 : 6)
                    .allowsHitTesting(unlocked)

                if !unlocked {
                    unlockOverlay
                }
            }

            Divider()

            HStack(spacing: 6) {
                Button {
                    if !unlocked {
                        unlock()
                        guard unlocked else { return }
                    }
                    editorDraft = .creating
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.borderless)
                .help("Add new secret")

                Button {
                    if let id = selection, let secret = secrets.first(where: { $0.id == id }) {
                        deletionTarget = secret
                    }
                } label: {
                    Image(systemName: "minus")
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.borderless)
                .disabled(!unlocked || selection == nil)
                .help("Delete selected secret")

                Spacer()

                Button("Edit…") {
                    if let id = selection, let secret = secrets.first(where: { $0.id == id }) {
                        editorDraft = .editing(secret)
                    }
                }
                .disabled(!unlocked || selection == nil)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .sheet(item: $editorDraft) { draft in
            SecretEditorSheet(
                draft: draft,
                existingNames: Set(secrets.map { $0.name }),
                onCancel: { editorDraft = nil },
                onSave: { saved in
                    save(draft: draft, secret: saved)
                    editorDraft = nil
                }
            )
        }
        .alert(
            "Delete secret?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { target in
            Button("Cancel", role: .cancel) { deletionTarget = nil }
            Button("Delete", role: .destructive) {
                delete(target)
                deletionTarget = nil
            }
        } message: { target in
            Text("Delete \(target.name)? This can't be undone.")
        }
        .alert(
            "Could not save secrets",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
        .frame(width: 620, height: 420)
    }

    private var table: some View {
        Table(displayedSecrets, selection: $selection) {
            TableColumn("Name") { secret in
                Text(secret.name)
                    .font(.system(.body, design: .monospaced))
            }
            .width(min: 140, ideal: 180)

            TableColumn("Value") { _ in
                Text("••••••••")
                    .foregroundStyle(.secondary)
                    .font(.system(.body, design: .monospaced))
            }
            .width(min: 80, ideal: 100)

            TableColumn("Hostname patterns") { secret in
                Text(secret.domains.joined(separator: ", "))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .contextMenu(forSelectionType: Secret.ID.self) { ids in
            if let id = ids.first, let secret = secrets.first(where: { $0.id == id }) {
                Button("Edit…") { editorDraft = .editing(secret) }
                Button("Delete…", role: .destructive) { deletionTarget = secret }
            }
        } primaryAction: { ids in
            if let id = ids.first, let secret = secrets.first(where: { $0.id == id }) {
                editorDraft = .editing(secret)
            }
        }
    }

    private var unlockOverlay: some View {
        Button {
            unlock()
        } label: {
            VStack(spacing: 10) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text("Stored in macOS Keychain")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Click to show secrets")
                    .font(.callout.weight(.medium))
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 22)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(.separator, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    /// Read the Keychain blob and reveal real secrets. On failure (auth
    /// cancelled, decode error, etc.) `unlocked` stays `false` so the
    /// overlay remains and the editor can't open against an empty
    /// snapshot — preventing a later save from overwriting stored secrets.
    private func unlock() {
        guard !unlocked else { return }
        do {
            let blob = try SecretsKeychain.readBlob()
            secrets = EnvFileFormat.parseSecrets(blob)
                .sorted(by: { $0.name < $1.name })
            errorMessage = nil
            unlocked = true
        } catch {
            log.error("unlock failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.secretsUnlock, error)
            errorMessage = error.localizedDescription
            unlocked = false
        }
    }

    private func save(draft: SecretDraft, secret: Secret) {
        if !unlocked {
            unlock()
            guard unlocked else { return }
        }
        var working = secrets
        if case .editing(let original) = draft {
            working.removeAll { $0.name == original.name }
        }
        working.removeAll { $0.name == secret.name }
        working.append(secret)
        persist(working)
    }

    private func delete(_ secret: Secret) {
        var working = secrets
        working.removeAll { $0.name == secret.name }
        persist(working)
    }

    private func persist(_ working: [Secret]) {
        let sorted = working.sorted(by: { $0.name < $1.name })
        do {
            try SecretsKeychain.writeBlob(EnvFileFormat.serialize(sorted))
            secrets = sorted
        } catch {
            log.error("persist failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.secretsPersist, error)
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Editor sheet

enum SecretDraft: Identifiable {
    case creating
    case editing(Secret)

    var id: String {
        switch self {
        case .creating: return "__new__"
        case .editing(let secret): return "edit:\(secret.name)"
        }
    }
}

private struct DomainEntry: Identifiable, Equatable {
    let id = UUID()
    var pattern: String
}

private struct SecretEditorSheet: View {
    let draft: SecretDraft
    let existingNames: Set<String>
    let onCancel: () -> Void
    let onSave: (Secret) -> Void

    @State private var name: String
    @State private var value: String
    @State private var domainEntries: [DomainEntry]

    init(
        draft: SecretDraft,
        existingNames: Set<String>,
        onCancel: @escaping () -> Void,
        onSave: @escaping (Secret) -> Void
    ) {
        self.draft = draft
        self.existingNames = existingNames
        self.onCancel = onCancel
        self.onSave = onSave
        switch draft {
        case .creating:
            _name = State(initialValue: "")
            _value = State(initialValue: "")
            _domainEntries = State(initialValue: [DomainEntry(pattern: "")])
        case .editing(let secret):
            _name = State(initialValue: secret.name)
            _value = State(initialValue: secret.value)
            let entries = secret.domains.map { DomainEntry(pattern: $0) }
            _domainEntries = State(initialValue: entries.isEmpty ? [DomainEntry(pattern: "")] : entries)
        }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespaces)
    }

    private var trimmedDomains: [String] {
        domainEntries
            .map { $0.pattern.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// First non-empty hostname pattern that fails the syntactic check, or
    /// `nil` if every pattern is valid (or empty — empties are filtered out
    /// before save).
    private var firstInvalidPattern: String? {
        for entry in domainEntries {
            let trimmed = entry.pattern.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if !EnvFileFormat.isValidHostnamePattern(trimmed) {
                return trimmed
            }
        }
        return nil
    }

    private var nameIsValid: Bool {
        SecretNameValidator.isValid(trimmedName)
    }

    private var nameCollides: Bool {
        switch draft {
        case .creating:
            return existingNames.contains(trimmedName)
        case .editing(let original):
            return trimmedName != original.name && existingNames.contains(trimmedName)
        }
    }

    private var canSave: Bool {
        nameIsValid
            && !nameCollides
            && !value.isEmpty
            && !trimmedDomains.isEmpty
            && firstInvalidPattern == nil
    }

    private var validationMessage: String? {
        if trimmedName.isEmpty { return "Name is required." }
        if !nameIsValid { return "Name may only contain letters, numbers, dots, underscores, and hyphens." }
        if nameCollides { return "A secret named \"\(trimmedName)\" already exists." }
        if value.isEmpty { return "Value is required." }
        if trimmedDomains.isEmpty { return "Add at least one hostname pattern." }
        if let bad = firstInvalidPattern {
            return "\"\(bad)\" is not a valid hostname pattern. Use `example.com`, `*.example.com`, or `*`."
        }
        return nil
    }

    private var isEditing: Bool {
        if case .editing = draft { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isEditing ? "Edit Secret" : "New Secret")
                .font(.headline)

            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    Text("Name").gridColumnAlignment(.trailing)
                    TextField("GITHUB_TOKEN", text: $name)
                        .textFieldStyle(.roundedBorder)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                }
                GridRow {
                    Text("Value").gridColumnAlignment(.trailing)
                    SecureField("ghp_…", text: $value)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                }
                GridRow(alignment: .top) {
                    Text("Hostnames")
                        .gridColumnAlignment(.trailing)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach($domainEntries) { $entry in
                            HStack(spacing: 6) {
                                TextField("api.github.com or *.github.com", text: $entry.pattern)
                                    .textFieldStyle(.roundedBorder)
                                    .disableAutocorrection(true)
                                    .font(.system(.body, design: .monospaced))
                                Button {
                                    removeDomain(entry.id)
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.borderless)
                                .help("Remove hostname pattern")
                            }
                        }
                        Button {
                            domainEntries.append(DomainEntry(pattern: ""))
                        } label: {
                            Label("Add hostname", systemImage: "plus.circle")
                                .font(.callout)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }

            Text("Each pattern matches one host. `*` matches any host; `*.example.com` matches subdomains only.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let message = validationMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Text(" ")
                    .font(.caption)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    onSave(Secret(name: trimmedName, value: value, domains: trimmedDomains))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSave)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func removeDomain(_ id: UUID) {
        guard let idx = domainEntries.firstIndex(where: { $0.id == id }) else { return }
        if domainEntries.count > 1 {
            domainEntries.remove(at: idx)
        } else {
            domainEntries[idx].pattern = ""
        }
    }
}
