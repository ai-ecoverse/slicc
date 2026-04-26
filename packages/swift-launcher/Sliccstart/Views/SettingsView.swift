import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "Settings")

/// UserDefaults key for the auto-launch browser. The value is the
/// `AppTarget.id` (bundle path) of the browser, or an empty string for
/// "None". Read at app startup by `SliccstartApp.initialize`.
let autoLaunchAppIdKey = "autoLaunchAppId"

struct SettingsView: View {
    var body: some View {
        TabView {
            StartupSettingsView()
                .tabItem { Label("Startup", systemImage: "power") }
            SecretsSettingsView()
                .tabItem { Label("Secrets", systemImage: "key.fill") }
        }
    }
}

// MARK: - Startup tab

struct StartupSettingsView: View {
    @AppStorage(autoLaunchAppIdKey) private var autoLaunchAppId: String = ""
    @State private var browsers: [AppTarget] = []

    var body: some View {
        Form {
            Picker(selection: $autoLaunchAppId) {
                Text("None").tag("")
                if !browsers.isEmpty {
                    Divider()
                    ForEach(browsers) { browser in
                        Text(browser.name).tag(browser.id)
                    }
                }
            } label: {
                Text("Launch on startup:")
            }
            .pickerStyle(.menu)
        }
        .padding(20)
        .frame(width: 460)
        .fixedSize()
        .onAppear {
            browsers = AppScanner.scan(hasAppManagementPermission: false)
                .filter { $0.type == .chromiumBrowser }
        }
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
                    if !unlocked { unlock() }
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

    private func unlock() {
        guard !unlocked else { return }
        secrets = EnvFileFormat.parseSecrets(SecretsKeychain.readBlob())
            .sorted(by: { $0.name < $1.name })
        unlocked = true
    }

    private func save(draft: SecretDraft, secret: Secret) {
        if !unlocked { unlock() }
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

    private var nameIsValid: Bool {
        guard !trimmedName.isEmpty else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_"))
        return CharacterSet(charactersIn: trimmedName).isSubset(of: allowed)
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
        nameIsValid && !nameCollides && !value.isEmpty && !trimmedDomains.isEmpty
    }

    private var validationMessage: String? {
        if trimmedName.isEmpty { return "Name is required." }
        if !nameIsValid { return "Name may only contain letters, numbers, and underscores." }
        if nameCollides { return "A secret named \"\(trimmedName)\" already exists." }
        if value.isEmpty { return "Value is required." }
        if trimmedDomains.isEmpty { return "Add at least one hostname pattern." }
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
