import Foundation
import SwiftOptel

enum LauncherErrorReport {

    enum Operation: String {
        case updateCheck = "update-check"
        case updateDetach = "update-detach"
        case bootstrap = "bootstrap"
        case bootstrapUpdate = "bootstrap-update"
        case launchStandalone = "launch-standalone"
        case launchElectron = "launch-electron"
        case autoLaunch = "auto-launch"
        case debugBuild = "debug-build"
        case terminalFollower = "terminal-follower"
        case reattach = "reattach"
        case secretsUnlock = "secrets-unlock"
        case secretsPersist = "secrets-persist"
        case defaultBrowser = "default-browser"
        case openIncomingUrl = "open-incoming-url"
    }

    static let maxTargetLength = 120

    static func report(_ operation: Operation, _ error: Error) {
        let mapping = mapping(operation: operation, error: error)
        Optel.shared.sample(.error, source: mapping.source, target: mapping.target)
    }

    static func mapping(operation: Operation, error: Error) -> OptelErrorMapping {
        let derived = OptelErrorMapping.from(error: error)
        return OptelErrorMapping(
            source: "sliccstart:\(operation.rawValue)",
            target: redact("\(derived.source): \(derived.target)")
        )
    }

    static func redact(_ message: String) -> String {
        var redacted = message
        for pattern in redactionPatterns {
            redacted = pattern.regex.stringByReplacingMatches(
                in: redacted,
                range: NSRange(redacted.startIndex..., in: redacted),
                withTemplate: pattern.replacement
            )
        }
        redacted = redacted.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if redacted.count > maxTargetLength {
            return String(redacted.prefix(maxTargetLength - 1)) + "…"
        }
        return redacted
    }

    private struct RedactionPattern {
        let regex: NSRegularExpression
        let replacement: String
    }

    private static let redactionPatterns: [RedactionPattern] = [

        (#"(?i)\b(token|secret|password|key)\b\s*[:=]\s*\S+"#, "$1=<redacted>"),
        (#"[a-zA-Z][a-zA-Z0-9+.-]*://\S*"#, "<url>"),
        (#"(?:/[^\s/:]+){2,}/?"#, "<path>"),
    ].compactMap { expression, replacement in
        guard let regex = try? NSRegularExpression(pattern: expression) else { return nil }
        return RedactionPattern(regex: regex, replacement: replacement)
    }
}
