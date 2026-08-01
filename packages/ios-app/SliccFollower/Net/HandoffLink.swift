import Foundation

// SLICC handoff/upskill extraction from parsed `Link` headers.
//
// Port of `packages/webapp/src/net/handoff-link.ts`, held to the same shared
// corpus as `LinkHeader`. See that file for why two implementations exist.

/// A recognised SLICC handoff advertised by a page response.
struct HandoffMatch: Equatable {
    enum Verb: String {
        case handoff
        case upskill
    }

    let verb: Verb
    /// Absolute URL of the payload. For the prose-only `handoff` verb the
    /// empty `<>` anchor resolves to the page itself.
    let target: String
    /// Free-form prose from the link's `title`, if any.
    var instruction: String?
    /// Upskill only: git ref carried by the `branch` param.
    var branch: String?
    /// Upskill only: repo-relative directory carried by the `path` param.
    var path: String?
}

enum HandoffLink {
    static let handoffRel = "https://www.sliccy.ai/rel/handoff"
    static let upskillRel = "https://www.sliccy.ai/rel/upskill"

    /// git `MAX_REF_NAMELEN`.
    private static let maxBranchLength = 250
    private static let maxPathLength = 1024

    /// Find the first SLICC-recognised link.
    ///
    /// Rel comparison is case-sensitive: RFC 8288 §2.1.1 mandates URI rels,
    /// and URI comparison is case-sensitive in path and query.
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

    /// Populate `branch` / `path`, dropping anything outside the allowlists.
    ///
    /// These values reach the cone inside a navigate-lick body and come back
    /// out as argv tokens in an `upskill` bash call rendered on an approval
    /// card. A value carrying `;`, a backtick, `$(`, or a newline could splice
    /// a second command past the visible code rows, so unsafe values are
    /// dropped silently — matching the "empty value → field omitted" contract
    /// rather than failing the whole handoff.
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

    /// Strip a trailing `/SKILL.md` so callers always see the containing
    /// directory, matching the TS canonicaliser.
    static func canonicalisePath(_ raw: String) -> String {
        var trimmed = raw
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let lower = trimmed.lowercased()
        if lower.hasSuffix("/skill.md") { return String(trimmed.dropLast("/skill.md".count)) }
        if lower == "skill.md" { return "" }
        return trimmed
    }

    /// `git check-ref-format` characters, ASCII only. Non-ASCII is rejected on
    /// purpose: a homoglyph ref renders identically on the approval card but
    /// resolves elsewhere.
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
        // A leading `-` would be read as a flag; a leading `/` is absolute and
        // the wire format is repo-relative.
        if value.hasPrefix("-") || value.hasPrefix("/") { return false }
        if value.contains("..") { return false }
        return true
    }

    private static func isSafeRefCharacter(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        switch ascii {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A:  // 0-9 A-Z a-z
            return true
        case 0x2E, 0x5F, 0x2F, 0x2D:  // . _ / -
            return true
        default:
            return false
        }
    }
}
