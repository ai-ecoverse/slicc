import Foundation

/// A single line in an .env file: `KEY=VALUE`.
struct EnvEntry: Sendable, Equatable {
    let key: String
    let value: String
}

/// Suffix used to pair a `KEY` line with its `KEY_DOMAINS` allowlist.
private let domainsSuffix = "_DOMAINS"

/// Parser/serializer for `.env`-style secret storage.
///
/// Mirrors `packages/shared-ts/src/secret-env-schema.ts` so the same blob
/// can round-trip between the Node store, the Swift Keychain blob, and
/// `--env-file` overrides without divergence.
enum EnvFileFormat {

    /// Parse `.env` content into ordered key-value pairs. Skips blank lines
    /// and `#` comments. Strips matching surrounding double or single quotes
    /// and unescapes `\"` inside double-quoted values.
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

    /// Secret values are stored one per line, so a value carrying a line break
    /// cannot survive a `serialize` → `parse` round-trip: `serialize` quotes it
    /// with a real LF inside the quotes and `parse` then splits on `\n`, keeping
    /// the unbalanced first line and dropping the rest. Writers reject such a
    /// value at the boundary instead of silently truncating it (issue #2828).
    ///
    /// Mirrors `isSingleLineSecretValue` in
    /// `packages/shared-ts/src/secret-env-schema.ts`; both sides are pinned by
    /// the cross-implementation vectors.
    /// Compares unicode scalars, not `Character`s: Swift treats CRLF as a
    /// SINGLE grapheme cluster that equals neither `"\n"` nor `"\r"`, so a
    /// `Character`-level check silently accepts a CRLF value that the JS
    /// `/[\n\r]/` rejects.
    static func isSingleLineValue(_ value: String) -> Bool {
        !value.unicodeScalars.contains { $0 == "\n" || $0 == "\r" }
    }

    /// The single rejection message both servers return for a multiline value.
    static func multilineValueError(_ name: String) -> String {
        "Secret \"\(name)\" value cannot contain newlines; the secret store is "
            + "line-oriented and would truncate it to the first line"
    }

    /// Serialize entries back to `.env` text. Values containing whitespace,
    /// `#`, or quotes are double-quoted with embedded `"` escaped as `\"`.
    ///
    /// Throws on a value containing a line break rather than emitting a blob
    /// that would parse back truncated. This is the fail-closed backstop behind
    /// the boundary checks in the two privileged servers' secret routes — no
    /// write path can corrupt the blob by going around them.
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

    /// Convert an env-file blob into `Secret` values. Pairs each `KEY` with
    /// its corresponding `KEY_DOMAINS` line; entries without a non-empty
    /// `KEY_DOMAINS` are dropped. Order follows the first `KEY` occurrence.
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

    /// Serialize a list of secrets into an env-file blob. Each secret emits
    /// a `KEY=value` line followed by `KEY_DOMAINS=domain1,domain2`.
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

    /// Split a comma-separated domain list, trimming whitespace and dropping
    /// empties.
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
