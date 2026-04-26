import Foundation
import Security

/// A SLICC secret managed by the Settings UI. `name` doubles as the stable
/// identity for SwiftUI lists and selection.
struct Secret: Equatable, Identifiable, Hashable {
    var name: String
    var value: String
    var domains: [String]

    var id: String { name }
}

enum SecretsError: LocalizedError {
    case keychainError(status: Int32)
    case emptyDomains
    case emptyName
    case duplicateName(String)

    var errorDescription: String? {
        switch self {
        case .keychainError(let status):
            return "Keychain error (\(status))"
        case .emptyDomains:
            return "At least one hostname pattern is required."
        case .emptyName:
            return "Name must not be empty."
        case .duplicateName(let name):
            return "A secret named \"\(name)\" already exists."
        }
    }
}

/// Read/write the single Keychain item that holds every SLICC secret.
///
/// Service: `ai.sliccy.slicc`
/// Account: `__envfile__`
/// Value: `.env`-formatted blob, identical layout to swift-server's
/// `SecretStore` and node-server's `~/.slicc/secrets.env`.
enum SecretsKeychain {
    static let service = "ai.sliccy.slicc"
    static let account = "__envfile__"

    static func readBlob() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
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

    static func writeBlob(_ content: String) throws {
        let valueData = Data(content.utf8)
        let searchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        let updateStatus = SecItemUpdate(
            searchQuery as CFDictionary,
            [kSecValueData as String: valueData] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }

        if updateStatus == errSecItemNotFound {
            var addQuery = searchQuery
            addQuery[kSecValueData as String] = valueData
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw SecretsError.keychainError(status: addStatus)
            }
            return
        }

        throw SecretsError.keychainError(status: updateStatus)
    }
}

/// Parser/serializer for the env-file blob. Mirrors swift-server's
/// `EnvFileFormat` and node-server's `env-file.ts`.
enum EnvFileFormat {
    static let domainsSuffix = "_DOMAINS"

    private struct Entry {
        let key: String
        let value: String
    }

    static func parseSecrets(_ content: String) -> [Secret] {
        let entries = parseEntries(content)
        var values: [String: String] = [:]
        var domains: [String: String] = [:]
        var order: [String] = []

        for entry in entries {
            if entry.key.hasSuffix(domainsSuffix) {
                let name = String(entry.key.dropLast(domainsSuffix.count))
                if !name.isEmpty {
                    domains[name] = entry.value
                }
            } else {
                if values[entry.key] == nil { order.append(entry.key) }
                values[entry.key] = entry.value
            }
        }

        var secrets: [Secret] = []
        for name in order {
            guard let value = values[name],
                  let domainsLine = domains[name] else { continue }
            let parsed = parseDomains(domainsLine)
            guard !parsed.isEmpty else { continue }
            secrets.append(Secret(name: name, value: value, domains: parsed))
        }
        return secrets
    }

    static func serialize(_ secrets: [Secret]) -> String {
        var lines: [String] = []
        for secret in secrets {
            lines.append("\(secret.name)=\(serializeValue(secret.value))")
            lines.append("\(secret.name)\(domainsSuffix)=\(serializeValue(secret.domains.joined(separator: ",")))")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func parseDomains(_ raw: String) -> [String] {
        raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private static func parseEntries(_ content: String) -> [Entry] {
        var entries: [Entry] = []
        for raw in content.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[line.startIndex..<eq].trimmingCharacters(in: .whitespacesAndNewlines)
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespacesAndNewlines)
            if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
                value = String(value.dropFirst().dropLast())
                    .replacingOccurrences(of: "\\\"", with: "\"")
            } else if value.hasPrefix("'") && value.hasSuffix("'") && value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            if !key.isEmpty {
                entries.append(Entry(key: key, value: value))
            }
        }
        return entries
    }

    private static func serializeValue(_ value: String) -> String {
        let needsQuoting = value.contains { ch in
            ch.isWhitespace || ch == "#" || ch == "\"" || ch == "'"
        }
        if !needsQuoting { return value }
        let escaped = value.replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
