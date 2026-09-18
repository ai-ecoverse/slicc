import Foundation





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




enum MemoryStore {
    static let memoryPath = "/workspace/CLAUDE.md"
    
    static let titleTarget = 64
    
    static let titleMax = 96

    private static let feedbackSection = try! NSRegularExpression(
        pattern: "\\b(feedback|reviews?|corrections?|learnings?|observations?|testing|verification)\\b",
        options: [.caseInsensitive])
    private static let userSection = try! NSRegularExpression(
        pattern:
            "\\b(user|preferences?|identit(?:y|ies)|accounts?|personal|interface|working rhythm|keyboard|accessibility)\\b",
        options: [.caseInsensitive])
    
    
    
    
    private static let autoExtractedSection = try! NSRegularExpression(
        pattern: "^Auto-extracted \\(", options: [])

    static func tag(forSection section: String, content: String = "") -> MemoryRow.Tag? {
        let sectionRange = NSRange(section.startIndex..., in: section)
        let autoExtracted =
            autoExtractedSection.firstMatch(in: section, range: sectionRange) != nil
        let evidence = autoExtracted ? content : "\(section) \(content)"
        let range = NSRange(evidence.startIndex..., in: evidence)
        if feedbackSection.firstMatch(in: evidence, range: range) != nil { return .feedback }
        if userSection.firstMatch(in: evidence, range: range) != nil { return .user }
        if autoExtracted || section.isEmpty { return nil }
        return .project
    }

    
    
    
    
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
                    tag: tag(forSection: section, content: body)))
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
                    
                    pending.append(stripped)
                }
            }
        }
        flush()
        if rows.isEmpty {
            
            
            
            let prose =
                markdown
                .split(separator: "\n", omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.hasPrefix("#") && !$0.isEmpty }
                .joined(separator: "\n")
            if !prose.isEmpty {
                let (title, _) = splitTitle(prose)
                rows.append(
                    MemoryRow(
                        id: 0, section: section, title: title, body: prose,
                        tag: tag(forSection: section, content: prose)))
            }
        }
        return rows
    }
}
