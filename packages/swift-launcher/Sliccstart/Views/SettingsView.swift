import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "Settings")

struct SettingsView: View {
    @State private var secrets: [Secret] = []
    @State private var selection: Secret.ID?
    @State private var editorDraft: SecretDraft?
    @State private var deletionTarget: Secret?
    @State private var errorMessage: String?

    var body: some View {
        TabView {
            secretsTab
                .tabItem { Label("Secrets", systemImage: "key.fill") }
        }
        .frame(width: 620, height: 420)
        .onAppear { reload() }
    }

    private var secretsTab: some View {
        VStack(spacing: 0) {
            Table(secrets, selection: $selection) {
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

            Divider()

            HStack(spacing: 6) {
                Button {
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
                .disabled(selection == nil)
                .help("Delete selected secret")

                Spacer()

                Button("Edit…") {
                    if let id = selection, let secret = secrets.first(where: { $0.id == id }) {
                        editorDraft = .editing(secret)
                    }
                }
                .disabled(selection == nil)
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
    }

    private func reload() {
        secrets = EnvFileFormat.parseSecrets(SecretsKeychain.readBlob())
            .sorted(by: { $0.name < $1.name })
    }

    private func save(draft: SecretDraft, secret: Secret) {
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

private struct SecretEditorSheet: View {
    let draft: SecretDraft
    let existingNames: Set<String>
    let onCancel: () -> Void
    let onSave: (Secret) -> Void

    @State private var name: String
    @State private var value: String
    @State private var domainsText: String

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
            _domainsText = State(initialValue: "")
        case .editing(let secret):
            _name = State(initialValue: secret.name)
            _value = State(initialValue: secret.value)
            _domainsText = State(initialValue: secret.domains.joined(separator: ", "))
        }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespaces)
    }

    private var parsedDomains: [String] {
        EnvFileFormat.parseDomains(domainsText)
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
        nameIsValid && !nameCollides && !value.isEmpty && !parsedDomains.isEmpty
    }

    private var validationMessage: String? {
        if trimmedName.isEmpty { return "Name is required." }
        if !nameIsValid { return "Name may only contain letters, numbers, and underscores." }
        if nameCollides { return "A secret named \"\(trimmedName)\" already exists." }
        if value.isEmpty { return "Value is required." }
        if parsedDomains.isEmpty { return "Add at least one hostname pattern." }
        return nil
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
                GridRow {
                    Text("Hostnames").gridColumnAlignment(.trailing)
                    TextField("api.github.com, *.github.com", text: $domainsText)
                        .textFieldStyle(.roundedBorder)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                }
            }

            Text("Comma-separated. `*` matches any host; `*.example.com` matches subdomains only.")
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
                    onSave(Secret(name: trimmedName, value: value, domains: parsedDomains))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSave)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private var isEditing: Bool {
        if case .editing = draft { return true }
        return false
    }
}
