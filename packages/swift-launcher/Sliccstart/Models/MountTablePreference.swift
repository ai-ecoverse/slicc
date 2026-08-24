import Foundation

/// The mount table: OS folders mapped to SLICC (VFS) targets, e.g.
/// `~/Projects/foo:/mnt/foo`. slicc-server serves each mapped folder over the
/// local `/api/hostfs` bridge and the webapp mounts it automatically at boot —
/// no File System Access picker, no Chrome permission prompt. Mounts the user
/// initiates inside the webapp (`mount <path>`) are untouched and keep asking.
///
/// Edited in Settings → Mounts as one mapping per line and persisted as a
/// single newline-separated string under `key`. At launch each mapping
/// becomes a repeatable `--mount=<os-path>:<slicc-path>` flag for
/// slicc-server. Parsing mirrors swift-server's
/// `ServerConfig.parseMountMapping` (last-colon split, `~` expansion) so the
/// UI never accepts a line the server would drop.
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
        // Reject `.`/`..`/empty segments — mirrors ServerConfig, so the UI
        // never accepts a line the server drops.
        if path != "/" {
            let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
                return nil
            }
        }
        return path
    }

    /// Parse one `<os-path>:<slicc-path>` line. Splits on the LAST `:` so OS
    /// paths containing `:` still parse; `~` expands to the home directory.
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

    /// Parse the editor text into a normalized table: one mapping per line,
    /// duplicates (by SLICC target) dropped in order.
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

    /// Lines the parser rejects, surfaced inline so a typo does not silently
    /// vanish from the table.
    static func invalidLines(in text: String) -> [String] {
        text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && mapping(fromLine: $0) == nil }
    }

    static func mappings(defaults: UserDefaults) -> [Mapping] {
        mappings(from: defaults.string(forKey: key) ?? "")
    }

    /// `--mount=<os>:<vfs>` flags for slicc-server, one per table entry.
    /// The `~` is already expanded here so the server never depends on the
    /// launcher's `$HOME` handling.
    static func serverArgs(mappings: [Mapping]) -> [String] {
        mappings.map { "--mount=\($0.hostPath):\($0.path)" }
    }

    static func serverArgs(defaults: UserDefaults) -> [String] {
        serverArgs(mappings: mappings(defaults: defaults))
    }

    // MARK: - Editor-table helpers (Settings → Mounts)

    static let mountRoot = "/mnt/"
    private static let generatedBase = mountRoot + "folder"

    /// Folder name → SLICC path segment: lowercased, spaces/colons dashed.
    static func sanitizedFolderName(_ name: String) -> String {
        let cleaned = name.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return cleaned.isEmpty ? "folder" : cleaned
    }

    /// `/mnt/<folder-name>` (or `…-2`, `…-3`) unique among `existing` targets.
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

    /// True for placeholder targets we minted ourselves (`/mnt/folder`,
    /// `/mnt/folder-2`, …) — safe to replace once a real folder is chosen.
    static func isGeneratedDefault(_ path: String) -> Bool {
        guard path.hasPrefix(generatedBase) else { return false }
        let suffix = path.dropFirst(generatedBase.count)
        return suffix.isEmpty || suffix.hasPrefix("-")
    }

    /// A row's SLICC path is valid when the parser accepts it and no other
    /// row claims the same target.
    static func isValidTarget(_ path: String, among targets: [String]) -> Bool {
        guard mapping(fromLine: "/x:\(path)") != nil else { return false }
        return targets.filter { $0 == path }.count == 1
    }

    /// `~`-abbreviate a host path for display.
    static func displayPath(_ path: String, homeDirectory: String = NSHomeDirectory()) -> String {
        guard !homeDirectory.isEmpty else { return path }
        if path == homeDirectory { return "~" }
        if path.hasPrefix(homeDirectory + "/") {
            return "~" + path.dropFirst(homeDirectory.count)
        }
        return path
    }

    /// Serialize editor rows back to the persisted newline format. Rows
    /// without a folder are UI-only drafts and are skipped.
    static func serialized(rows: [(hostPath: String, path: String)]) -> String {
        rows.compactMap { row in
            row.hostPath.isEmpty ? nil : "\(row.hostPath):\(row.path)"
        }.joined(separator: "\n")
    }
}
