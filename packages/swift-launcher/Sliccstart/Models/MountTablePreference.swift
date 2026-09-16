import Foundation

enum MountTablePreference {
    static let key = "autoMountTable"

    struct Mapping: Equatable {
        let hostPath: String
        let path: String
    }

    private static func normalizedAbsolutePath(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("/") else { return nil }
        var path = trimmed
        while path.count > 1, path.hasSuffix("/") {
            path.removeLast()
        }
        guard !path.isEmpty else { return nil }

        if path != "/" {
            let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
                return nil
            }
        }
        return path
    }

    static func mapping(
        fromLine line: String,
        homeDirectory: String = NSHomeDirectory()
    ) -> Mapping? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let sep = trimmed.lastIndex(of: ":"), sep != trimmed.startIndex else { return nil }
        var hostRaw = String(trimmed[trimmed.startIndex..<sep]).trimmingCharacters(in: .whitespaces)
        let targetRaw = String(trimmed[trimmed.index(after: sep)...])
            .trimmingCharacters(in: .whitespaces)
        if hostRaw == "~" || hostRaw.hasPrefix("~/") {
            guard !homeDirectory.isEmpty else { return nil }
            hostRaw = homeDirectory + hostRaw.dropFirst()
        }
        guard let hostPath = normalizedAbsolutePath(hostRaw),
            let path = normalizedAbsolutePath(targetRaw),
            path != "/"
        else { return nil }
        return Mapping(hostPath: hostPath, path: path)
    }

    static func mappings(from text: String) -> [Mapping] {
        var seen = Set<String>()
        var result: [Mapping] = []
        for line in text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            guard let mapping = mapping(fromLine: String(line)) else { continue }
            guard seen.insert(mapping.path).inserted else { continue }
            result.append(mapping)
        }
        return result
    }

    static func invalidLines(in text: String) -> [String] {
        text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && mapping(fromLine: $0) == nil }
    }

    static func mappings(defaults: UserDefaults) -> [Mapping] {
        mappings(from: defaults.string(forKey: key) ?? "")
    }

    static func serverArgs(mappings: [Mapping]) -> [String] {
        mappings.map { "--mount=\($0.hostPath):\($0.path)" }
    }

    static func serverArgs(defaults: UserDefaults) -> [String] {
        serverArgs(mappings: mappings(defaults: defaults))
    }

    static let mountRoot = "/mnt/"
    private static let generatedBase = mountRoot + "folder"

    static func sanitizedFolderName(_ name: String) -> String {
        let cleaned = name.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return cleaned.isEmpty ? "folder" : cleaned
    }

    static func defaultTarget(forFolderNamed name: String?, existing: [String]) -> String {
        let base = mountRoot + (name.map(sanitizedFolderName) ?? "folder")
        var candidate = base
        var counter = 2
        while existing.contains(candidate) {
            candidate = "\(base)-\(counter)"
            counter += 1
        }
        return candidate
    }

    static func isGeneratedDefault(_ path: String) -> Bool {
        guard path.hasPrefix(generatedBase) else { return false }
        let suffix = path.dropFirst(generatedBase.count)
        return suffix.isEmpty || suffix.hasPrefix("-")
    }

    static func isValidTarget(_ path: String, among targets: [String]) -> Bool {
        guard mapping(fromLine: "/x:\(path)") != nil else { return false }
        return targets.filter { $0 == path }.count == 1
    }

    static func displayPath(_ path: String, homeDirectory: String = NSHomeDirectory()) -> String {
        guard !homeDirectory.isEmpty else { return path }
        if path == homeDirectory { return "~" }
        if path.hasPrefix(homeDirectory + "/") {
            return "~" + path.dropFirst(homeDirectory.count)
        }
        return path
    }

    static func serialized(rows: [(hostPath: String, path: String)]) -> String {
        rows.compactMap { row in
            row.hostPath.isEmpty ? nil : "\(row.hostPath):\(row.path)"
        }.joined(separator: "\n")
    }
}
