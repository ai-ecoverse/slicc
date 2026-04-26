import Foundation
import Security

/// A secret entry returned by `list()` — name + domains, never the value.
struct SecretEntry: Sendable, Equatable {
    let name: String
    let domains: [String]
}

/// A retrieved secret with its value and domain allowlist.
struct Secret: Sendable, Equatable {
    let name: String
    let value: String
    let domains: [String]
}

enum SecretStoreError: Error, Sendable, Equatable {
    case emptyDomains
    case keychainError(status: Int32)
}

/// Keychain service identifier used for the SLICC secrets blob.
private let keychainService = "ai.sliccy.slicc"

/// Account name for the single Keychain item that holds every secret.
private let keychainAccount = "__envfile__"

/// CRUD operations for secrets stored in the macOS Keychain.
///
/// All secrets live in a single `kSecClassGenericPassword` item under
/// service `ai.sliccy.slicc` and account `__envfile__`. The item's value
/// is an `.env`-formatted blob (`KEY=value` paired with `KEY_DOMAINS=...`)
/// using the same format as `~/.slicc/secrets.env` consumed by node-server.
///
/// One item means one Keychain access prompt per signed binary, regardless
/// of how many secrets the user stores. The same item is read by Sliccstart
/// to power its Settings UI.
enum SecretStore {

    /// Serializes blob mutations within a single process.
    private static let lock = NSLock()

    static func get(name: String) -> Secret? {
        readSecrets().first(where: { $0.name == name })
    }

    static func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw SecretStoreError.emptyDomains
        }
        try mutate { secrets in
            let entry = Secret(name: name, value: value, domains: domains)
            if let idx = secrets.firstIndex(where: { $0.name == name }) {
                secrets[idx] = entry
            } else {
                secrets.append(entry)
            }
        }
    }

    static func delete(name: String) throws {
        try mutate { secrets in
            secrets.removeAll { $0.name == name }
        }
    }

    static func list() -> [SecretEntry] {
        readSecrets().map { SecretEntry(name: $0.name, domains: $0.domains) }
    }

    // MARK: - Blob accessors

    /// Read the env-file blob from Keychain. Returns `""` if the item does
    /// not exist yet.
    static func readBlob() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    /// Replace the env-file blob in Keychain (creates the item on first use).
    static func writeBlob(_ content: String) throws {
        let valueData = Data(content.utf8)
        let searchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]

        let updateStatus = SecItemUpdate(
            searchQuery as CFDictionary,
            [kSecValueData as String: valueData] as CFDictionary
        )

        if updateStatus == errSecSuccess {
            return
        }

        if updateStatus == errSecItemNotFound {
            var addQuery = searchQuery
            addQuery[kSecValueData as String] = valueData
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw SecretStoreError.keychainError(status: addStatus)
            }
            return
        }

        throw SecretStoreError.keychainError(status: updateStatus)
    }

    // MARK: - Private

    private static func readSecrets() -> [Secret] {
        EnvFileFormat.secretsFromBlob(readBlob())
    }

    private static func mutate(_ change: (inout [Secret]) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        var secrets = EnvFileFormat.secretsFromBlob(readBlob())
        change(&secrets)
        try writeBlob(EnvFileFormat.blobFromSecrets(secrets))
    }
}
