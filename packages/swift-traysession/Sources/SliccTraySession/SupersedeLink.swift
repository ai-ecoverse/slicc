import Foundation

/// The RFC 8288 `Link` header a superseded tray answers with (#1957).
///
/// The tray hub stamps `Link: <replacement>; rel="successor-version"` — the
/// relation registered by RFC 5829 §3.4 — alongside the 308 `Location` and the
/// JSON body that carry the same address. The header is the channel that
/// survives a body-shape change, so a follower that reads it keeps working when
/// the body stops saying `action: "fail"` / `code: "TRAY_SUPERSEDED"`, and when
/// it cannot be decoded at all. Reading only the body is what stranded this
/// follower in #1956.
///
/// Deliberately narrow: the hub emits one well-formed link plus its standard
/// rel set, so this handles the shapes that actually arrive rather than
/// reimplementing the full grammar. Kept behaviourally identical to
/// `successorVersionFromLinkHeader` in
/// `packages/shared-ts/src/tray-signaling.ts` and
/// `SuccessorVersionFromLinkHeader` in
/// `packages/slicc-cli/internal/signaling/link.go`; the pinned vectors in
/// `SupersedeLinkTests.swift` are the same table those packages pin.
///
/// This is the twin of `SupersedeLink` in `packages/swift-trayfollower`,
/// duplicated because this package is deliberately Foundation-only and depends
/// on nothing — the liveness probe needs the same reading of the same header.
/// The two files and their pinned vectors move together.
public enum SupersedeLink {
    /// RFC 5829 relation naming the tray that replaced this one.
    public static let rel = "successor-version"

    /// Pull the `successor-version` target out of a response's `Link` header.
    ///
    /// Returns nil when there is no such link. Relative references are
    /// rejected: a replacement tray is always absolute, and resolving one
    /// against the wrong base would dial an unusable address.
    public static func successor(in header: String?) -> URL? {
        guard let header, !header.isEmpty else { return nil }
        // Some platforms join repeated header instances with a newline.
        let merged = header.replacingOccurrences(of: "\n", with: ", ")
        for value in splitOutsideQuotes(merged, separator: ",") {
            guard value.hasPrefix("<"), let uriEnd = value.firstIndex(of: ">") else { continue }
            let params = String(value[value.index(after: uriEnd)...])
            guard hasSuccessorRel(params) else { continue }
            let target = String(value[value.index(after: value.startIndex)..<uriEnd])
                .trimmingCharacters(in: .whitespaces)
            guard let url = URL(string: target), url.scheme != nil, url.host != nil else {
                return nil
            }
            return url
        }
        return nil
    }

    /// Read the link straight off an HTTP response.
    public static func successor(in response: HTTPURLResponse) -> URL? {
        successor(in: response.value(forHTTPHeaderField: "Link"))
    }

    /// The replacement named by a suppressed 3xx's `Location`, or nil.
    ///
    /// Read after `successor(in:)`, never instead of it: the hub puts
    /// `json=true` on `Location` so that a client which lets `URLSession`
    /// follow the redirect still reaches the tray API rather than the SPA
    /// fallback, while the link stays the canonical join URL. The parameter is
    /// dropped here for the same reason — callers append their own and persist
    /// what this returns. A relative or scheme-less target yields nil rather
    /// than an address resolved against a guessed base.
    public static func redirectTarget(in response: HTTPURLResponse) -> URL? {
        guard (300..<400).contains(response.statusCode),
            let raw = response.value(forHTTPHeaderField: "Location"),
            var components = URLComponents(string: raw),
            components.scheme != nil, components.host != nil
        else { return nil }
        let remaining = (components.queryItems ?? []).filter { $0.name != "json" }
        components.queryItems = remaining.isEmpty ? nil : remaining
        return components.url
    }

    /// Split on `separator` at the top level — separators inside a
    /// quoted-string or an angle-bracketed URI-reference belong to the value,
    /// not the grammar. (A `Link` target may legitimately contain both:
    /// `<https://a/b;c?d,e>`.)
    private static func splitOutsideQuotes(_ input: String, separator: Character) -> [String] {
        var out: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        var escaped = false
        for ch in input {
            if inQuotes {
                current.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inQuotes = false
                }
                continue
            }
            switch ch {
            case "\"": inQuotes = true
            case "<": inAngle = true
            case ">": inAngle = false
            default: break
            }
            if ch == separator && !inAngle {
                out.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                continue
            }
            current.append(ch)
        }
        out.append(current.trimmingCharacters(in: .whitespaces))
        return out.filter { !$0.isEmpty }
    }

    /// True when a link-value's parameter list declares `rel=successor-version`.
    private static func hasSuccessorRel(_ params: String) -> Bool {
        for param in splitOutsideQuotes(params, separator: ";") {
            guard let eq = param.firstIndex(of: "=") else { continue }
            let name = param[..<eq].trimmingCharacters(in: .whitespaces)
            guard name.lowercased() == "rel" else { continue }
            var value = String(param[param.index(after: eq)...])
                .trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            // `rel` is a space-separated list of relation types, matched
            // case-insensitively.
            if value.split(whereSeparator: { $0.isWhitespace })
                .contains(where: { $0.lowercased() == rel })
            {
                return true
            }
        }
        return false
    }
}
