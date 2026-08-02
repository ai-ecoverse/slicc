import Foundation

/// One memory bullet from the cone's `/workspace/CLAUDE.md`, mirroring the
/// web memory surface's row model (`wc-memory.ts`): section headings carry
/// into the row, the first clause becomes the title, and the section name
/// classifies the row (user / feedback / project).
struct MemoryRow: Identifiable, Equatable {
    enum Tag: String {
        case user, feedback, project
    }

    let id: Int
    let section: String
    let title: String
    let body: String
    let tag: Tag?
}

/// Parser for the memory markdown — sections (`##`/`###` headings) holding
/// `-` bullets with hanging continuations. Pure and synchronous so the
/// row model is unit-testable without a leader.
enum MemoryStore {
    static let memoryPath = "/workspace/CLAUDE.md"
    /// `TITLE_TARGET` (`wc-memory.ts`) — aim the title split near here.
    static let titleTarget = 64
    /// `MEMORY_TITLE_MAX` — lossless hard cap on the title clause.
    static let titleMax = 96

    private static let feedbackSection = try! NSRegularExpression(
        pattern: "\\b(feedback|reviews?|corrections?|learnings?|observations?|testing|verification)\\b",
        options: [.caseInsensitive])
    private static let userSection = try! NSRegularExpression(
        pattern:
            "\\b(user|preferences?|identit(?:y|ies)|accounts?|personal|interface|working rhythm|keyboard|accessibility)\\b",
        options: [.caseInsensitive])

    static func tag(forSection section: String) -> MemoryRow.Tag? {
        let range = NSRange(section.startIndex..., in: section)
        if feedbackSection.firstMatch(in: section, range: range) != nil { return .feedback }
        if userSection.firstMatch(in: section, range: range) != nil { return .user }
        if section.isEmpty { return nil }
        return .project
    }

    /// Split a bullet into title + rest: prefer a clause boundary (`.`,
    /// `;`, ` — `) near the target, fall back to a word boundary under the
    /// hard cap (web parity in spirit — the exact clause heuristics stay
    /// with the richer web renderer).
    static func splitTitle(_ text: String) -> (title: String, rest: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > titleMax else { return (trimmed, "") }
        let candidates: [Character] = [".", ";", ":"]
        let prefix = String(trimmed.prefix(titleMax))
        var cut: String.Index?
        for (offset, char) in prefix.enumerated() where candidates.contains(char) {
            if offset >= 12 { cut = prefix.index(prefix.startIndex, offsetBy: offset) }
        }
        if cut == nil {
            cut = prefix.lastIndex(of: " ")
        }
        guard let cutIndex = cut else { return (prefix, String(trimmed.dropFirst(titleMax))) }
        let title = String(prefix[..<cutIndex]).trimmingCharacters(in: .whitespaces)
        let rest = String(trimmed[cutIndex...]).trimmingCharacters(
            in: CharacterSet(charactersIn: " .;:"))
        return (title, rest)
    }

    /// Parse the whole memory file into rows, dropping heading-only noise.
    static func parse(_ markdown: String) -> [MemoryRow] {
        var rows: [MemoryRow] = []
        var section = ""
        var pending: [String] = []

        func flush() {
            guard !pending.isEmpty else { return }
            let body = pending.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            pending = []
            guard !body.isEmpty else { return }
            let (title, _) = splitTitle(body)
            rows.append(
                MemoryRow(
                    id: rows.count, section: section, title: title, body: body,
                    tag: tag(forSection: section)))
        }

        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let stripped = line.trimmingCharacters(in: .whitespaces)
            if stripped.hasPrefix("#") {
                flush()
                section = stripped.drop(while: { $0 == "#" })
                    .trimmingCharacters(in: .whitespaces)
                continue
            }
            if stripped.hasPrefix("- ") || stripped.hasPrefix("* ") {
                flush()
                pending = [String(stripped.dropFirst(2))]
                continue
            }
            if !pending.isEmpty {
                if stripped.isEmpty {
                    flush()
                } else {
                    // Hanging continuation of the open bullet.
                    pending.append(stripped)
                }
            }
        }
        flush()
        return rows
    }
}
