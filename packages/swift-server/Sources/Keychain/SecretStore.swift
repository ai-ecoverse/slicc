import Foundation
import Security

struct SecretEntry: Sendable, Equatable {
    let name: String
    let domains: [String]
}

struct Secret: Sendable, Equatable {
    let name: String
    let value: String
    let domains: [String]
}

struct SecretStoreAccess: Sendable {
    let loadAll: @Sendable () -> [Secret]
    let save: @Sendable (_ name: String, _ value: String, _ domains: [String]) throws -> Void
    let remove: @Sendable (_ name: String) throws -> Void

    func get(name: String) -> Secret? {
        loadAll().first(where: { $0.name == name })
    }

    func list() -> [SecretEntry] {
        loadAll().map { SecretEntry(name: $0.name, domains: $0.domains) }
    }

    static let keychain = SecretStoreAccess(
        loadAll: { SecretStore.all() },
        save: { name, value, domains in try SecretStore.set(name: name, value: value, domains: domains) },
        remove: { name in try SecretStore.delete(name: name) }
    )
}

enum SecretStoreError: Error, Sendable, Equatable, LocalizedError {
    case emptyDomains

    case multilineValue(name: String)
    case keychainError(status: Int32)

    var errorDescription: String? {
        switch self {
        case .multilineValue(let name): return EnvFileFormat.multilineValueError(name)
        case .emptyDomains, .keychainError: return nil
        }
    }
}

private let keychainService = "ai.sliccy.slicc"

private let keychainAccount = "__envfile__"

enum SecretStore {

    private static let lock = NSLock()

    private static var nonInteractive: Bool {
        ProcessInfo.processInfo.environment["SLICC_KEYCHAIN_NONINTERACTIVE"] == "1"
    }

    static var setUserInteractionAllowed: (Bool) -> Void = { allowed in
        SecKeychainSetUserInteractionAllowed(allowed)
    }

    private static func withInteractionSuppressed<T>(_ body: () throws -> T) rethrows -> T {
        guard nonInteractive else { return try body() }
        setUserInteractionAllowed(false)
        defer { setUserInteractionAllowed(true) }
        return try body()
    }

    static func get(name: String) -> Secret? {
        readSecrets().first(where: { $0.name == name })
    }

    static func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw SecretStoreError.emptyDomains
        }

        guard EnvFileFormat.isSingleLineValue(value) else {
            throw SecretStoreError.multilineValue(name: name)
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

    static func all() -> [Secret] {
        readSecrets()
    }

    static func readBlob() throws -> String {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        if nonInteractive {
            query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        }
        var result: AnyObject?
        let status = withInteractionSuppressed {
            SecItemCopyMatching(query as CFDictionary, &result)
        }
        if status == errSecItemNotFound {
            return ""
        }
        guard status == errSecSuccess else {
            throw SecretStoreError.keychainError(status: status)
        }
        guard let data = result as? Data,
            let text = String(data: data, encoding: .utf8)
        else {
            throw SecretStoreError.keychainError(status: errSecDecode)
        }
        return text
    }

    static func writeBlob(_ content: String) throws {
        let valueData = Data(content.utf8)
        let searchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]

        let updateStatus = withInteractionSuppressed {
            SecItemUpdate(
                searchQuery as CFDictionary,
                [kSecValueData as String: valueData] as CFDictionary
            )
        }

        if updateStatus == errSecSuccess {
            return
        }

        if updateStatus == errSecItemNotFound {
            var addQuery = searchQuery
            addQuery[kSecValueData as String] = valueData
            let addStatus = withInteractionSuppressed { SecItemAdd(addQuery as CFDictionary, nil) }
            guard addStatus == errSecSuccess else {
                throw SecretStoreError.keychainError(status: addStatus)
            }
            return
        }

        throw SecretStoreError.keychainError(status: updateStatus)
    }

    private static func readSecrets() -> [Secret] {
        do {
            return EnvFileFormat.secretsFromBlob(try readBlob())
        } catch SecretStoreError.keychainError(let status) where status == errSecInteractionNotAllowed {

            FileHandle.standardError.write(
                Data(
                    ("[slicc:secrets] Keychain access blocked (errSecInteractionNotAllowed) for "
                        + "\(keychainService)/\(keychainAccount); continuing without stored secrets. "
                        + "Durable fix: sign the binary with a stable identity and click "
                        + "\"Always Allow\" once — see packages/dev-tools/tools/setup-dev-cert.sh. "
                        + "(One-off non-interactive grant for the stable identity: "
                        + "security set-generic-password-partition-list "
                        + "-S apple-tool:,apple: -s \(keychainService) -a \(keychainAccount) "
                        + "-k <login-password>.)\n").utf8
                ))
            return []
        } catch {
            return []
        }
    }

    private static func mutate(_ change: (inout [Secret]) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        let blob = try readBlob()
        var secrets = EnvFileFormat.secretsFromBlob(blob)
        change(&secrets)
        try writeBlob(try EnvFileFormat.blobFromSecrets(secrets))
    }
}
