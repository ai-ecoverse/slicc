import Foundation


struct EnvEntry: Sendable, Equatable {
    let key: String
    let value: String
}


private let domainsSuffix = "_DOMAINS"






enum EnvFileFormat {

    
    
    
    static func parse(_ content: String) -> [EnvEntry] {
        var entries: [EnvEntry] = []
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
                entries.append(EnvEntry(key: key, value: value))
            }
        }
        return entries
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    static func isSingleLineValue(_ value: String) -> Bool {
        !value.unicodeScalars.contains { $0 == "\n" || $0 == "\r" }
    }

    
    static func multilineValueError(_ name: String) -> String {
        "Secret \"\(name)\" value cannot contain newlines; the secret store is "
            + "line-oriented and would truncate it to the first line"
    }

    
    
    
    
    
    
    
    static func serialize(_ entries: [EnvEntry]) throws -> String {
        var lines: [String] = []
        for entry in entries {
            guard isSingleLineValue(entry.value) else {
                throw SecretStoreError.multilineValue(name: entry.key)
            }
            lines.append("\(entry.key)=\(serializeValue(entry.value))")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    
    
    
    static func secretsFromBlob(_ content: String) -> [Secret] {
        let entries = parse(content)
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
                if values[entry.key] == nil {
                    order.append(entry.key)
                }
                values[entry.key] = entry.value
            }
        }

        var result: [Secret] = []
        for name in order {
            guard let value = values[name],
                let domainsLine = domains[name]
            else { continue }
            let parsed = parseDomains(domainsLine)
            guard !parsed.isEmpty else { continue }
            result.append(Secret(name: name, value: value, domains: parsed))
        }
        return result
    }

    
    
    static func blobFromSecrets(_ secrets: [Secret]) throws -> String {
        var entries: [EnvEntry] = []
        for secret in secrets {
            entries.append(EnvEntry(key: secret.name, value: secret.value))
            entries.append(
                EnvEntry(
                    key: secret.name + domainsSuffix,
                    value: secret.domains.joined(separator: ",")
                ))
        }
        return try serialize(entries)
    }

    
    
    static func parseDomains(_ raw: String) -> [String] {
        raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
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
