import Foundation

/// Process-memory-only session secrets. Values are never persisted to Keychain
/// or disk and disappear when the server process exits.
actor SessionSecretStore {
    struct Record: Sendable, Equatable {
        let name: String
        let value: String
        let domains: [String]
    }

    private var entries: [String: Record] = [:]

    func set(name: String, value: String, domains: [String] = []) {
        entries[name] = Record(name: name, value: value, domains: domains)
    }

    func getRecord(name: String) -> Record? {
        entries[name]
    }

    func setDomains(name: String, domains: [String]) -> Bool {
        guard let existing = entries[name] else { return false }
        entries[name] = Record(name: name, value: existing.value, domains: domains)
        return true
    }

    func delete(name: String) -> Bool {
        entries.removeValue(forKey: name) != nil
    }

    func listAll() -> [Record] {
        Array(entries.values)
    }

    func list() -> [SecretEntry] {
        entries.values.map { SecretEntry(name: $0.name, domains: $0.domains) }
    }
}

/// Return a partial preview while always eliding at least one character.
func previewSecret(_ value: String, edge: Int = 4) -> String {
    let characters = Array(value)
    guard !characters.isEmpty else { return "" }
    guard characters.count > 2 else { return "…" }
    let visibleEdge = min(max(1, edge), (characters.count - 1) / 2)
    return String(characters.prefix(visibleEdge)) + "…" + String(characters.suffix(visibleEdge))
}
