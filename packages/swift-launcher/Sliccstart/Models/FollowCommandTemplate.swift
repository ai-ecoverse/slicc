import Foundation

enum FollowCommandTemplate {
    static let defaultTemplate = "{slicc} {joinUrl} follow {shell} -c"
    static let redactedJoinURL = "https://www.sliccy.ai/join/<redacted>"

    static func expand(
        template: String,
        sliccPath: String,
        joinURL: String,
        shellPath: String
    ) -> String {
        effectiveTemplate(template)
            .replacingOccurrences(of: "{slicc}", with: shellQuote(sliccPath))
            .replacingOccurrences(of: "{joinUrl}", with: shellQuote(joinURL))
            .replacingOccurrences(of: "{shell}", with: shellQuote(shellPath))
    }

    static func preview(template: String, sliccPath: String, shellPath: String) -> String {
        expand(
            template: template,
            sliccPath: sliccPath,
            joinURL: redactedJoinURL,
            shellPath: shellPath
        )
    }

    static func effectiveTemplate(_ template: String) -> String {
        let isEmpty = template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return isEmpty || !template.contains("{joinUrl}") ? defaultTemplate : template
    }

    private static func shellQuote(_ value: String) -> String {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_@%+=:,./-"))
        if !value.isEmpty, value.unicodeScalars.allSatisfy(safe.contains) { return value }
        return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }
}
