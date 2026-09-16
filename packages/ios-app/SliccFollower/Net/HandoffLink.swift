import Foundation

struct HandoffMatch: Equatable {
    enum Verb: String {
        case handoff
        case upskill
    }

    let verb: Verb

    let target: String

    var instruction: String?

    var branch: String?

    var path: String?
}

enum HandoffLink {
    static let handoffRel = "https://www.sliccy.ai/rel/handoff"
    static let upskillRel = "https://www.sliccy.ai/rel/upskill"

    private static let maxBranchLength = 250
    private static let maxPathLength = 1024

    static func extract(from links: [ParsedLink]) -> HandoffMatch? {
        for link in links {
            if link.rel.contains(handoffRel) {
                var match = HandoffMatch(verb: .handoff, target: link.href)
                match.instruction = nonEmptyTitle(link)
                return match
            }
            if link.rel.contains(upskillRel) {
                var match = HandoffMatch(verb: .upskill, target: link.href)
                match.instruction = nonEmptyTitle(link)
                applyUpskillParams(&match, params: link.params)
                return match
            }
        }
        return nil
    }

    private static func nonEmptyTitle(_ link: ParsedLink) -> String? {
        guard let title = link.title, !title.isEmpty else { return nil }
        return title
    }

    private static func applyUpskillParams(
        _ match: inout HandoffMatch, params: [String: String]
    ) {
        if let branch = params["branch"], isSafeBranch(branch) {
            match.branch = branch
        }
        if let raw = params["path"], !raw.isEmpty {
            let canonical = canonicalisePath(raw)
            if !canonical.isEmpty, isSafePath(canonical) {
                match.path = canonical
            }
        }
    }

    static func canonicalisePath(_ raw: String) -> String {
        var trimmed = raw
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let lower = trimmed.lowercased()
        if lower.hasSuffix("/skill.md") { return String(trimmed.dropLast("/skill.md".count)) }
        if lower == "skill.md" { return "" }
        return trimmed
    }

    static func isSafeBranch(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maxBranchLength else { return false }
        guard value.allSatisfy(isSafeRefCharacter) else { return false }
        if value.hasPrefix("-") || value.hasPrefix("/") || value.hasSuffix("/") { return false }
        if value.contains("..") { return false }
        if value.hasSuffix(".lock") { return false }
        return true
    }

    static func isSafePath(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maxPathLength else { return false }
        guard value.allSatisfy(isSafeRefCharacter) else { return false }

        if value.hasPrefix("-") || value.hasPrefix("/") { return false }
        if value.contains("..") { return false }
        return true
    }

    private static func isSafeRefCharacter(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        switch ascii {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A:
            return true
        case 0x2E, 0x5F, 0x2F, 0x2D:
            return true
        default:
            return false
        }
    }
}
