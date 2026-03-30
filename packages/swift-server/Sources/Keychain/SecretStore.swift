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

/// Keychain service identifier used for all SLICC secrets.
private let keychainService = "ai.sliccy.slicc"

/// CRUD operations for secrets stored in the macOS Keychain.
///
/// - Service: `ai.sliccy.slicc`
/// - Account: secret name (e.g. `GITHUB_TOKEN`)
/// - Value: secret value in `kSecValueData`
/// - Domains: comma-separated in `kSecAttrComment`
enum SecretStore {

    /// Retrieve a secret and its domains from the Keychain.
    static func get(name: String) -> Secret? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: name,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
            let attrs = result as? [String: Any],
            let data = attrs[kSecValueData as String] as? Data,
            let value = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        let comment = attrs[kSecAttrComment as String] as? String ?? ""
        let domains = parseDomains(comment)
        return Secret(name: name, value: value, domains: domains)
    }

    /// Store or update a secret in the Keychain.
    /// - Throws: `SecretStoreError.emptyDomains` if `domains` is empty.
    static func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw SecretStoreError.emptyDomains
        }

        let comment = domains.joined(separator: ",")
        let valueData = Data(value.utf8)

        // Try to update first.
        let searchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: name,
        ]
        let updateAttrs: [String: Any] = [
            kSecValueData as String: valueData,
            kSecAttrComment as String: comment,
        ]

        let updateStatus = SecItemUpdate(searchQuery as CFDictionary, updateAttrs as CFDictionary)

        if updateStatus == errSecSuccess {
            return
        }

        if updateStatus == errSecItemNotFound {
            // Add new item.
            var addQuery = searchQuery
            addQuery[kSecValueData as String] = valueData
            addQuery[kSecAttrComment as String] = comment

            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw SecretStoreError.keychainError(status: addStatus)
            }
            return
        }

        throw SecretStoreError.keychainError(status: updateStatus)
    }

    /// Remove a secret from the Keychain.
    static func delete(name: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: name,
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecretStoreError.keychainError(status: status)
        }
    }

    /// List all secret names and domains (never values).
    static func list() -> [SecretEntry] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
            let items = result as? [[String: Any]]
        else {
            return []
        }

        return items.compactMap { attrs in
            guard let account = attrs[kSecAttrAccount as String] as? String else {
                return nil
            }
            let comment = attrs[kSecAttrComment as String] as? String ?? ""
            return SecretEntry(name: account, domains: parseDomains(comment))
        }
    }

    /// Parse a comma-separated domain string, trimming whitespace and
    /// dropping empty entries.
    private static func parseDomains(_ raw: String) -> [String] {
        raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

