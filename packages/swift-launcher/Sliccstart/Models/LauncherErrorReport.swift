import Foundation
import SwiftOptel

/// Emits RUM `error` checkpoints for the launcher's Swift-`Error` boundaries.
///
/// `.optelAutoInstrument` only hooks Objective-C `NSException`s, and Swift
/// errors are values that cannot be intercepted globally, so every `do/catch`
/// in Sliccstart used to end in `os.Logger` and an alert with nothing reaching
/// `helix_rum`. Grouping happens on `source` (`sliccstart:<operation>`), so a
/// spike in one operation is visible without reading per-machine logs.
///
/// Error text is redacted before it leaves the machine: launcher errors quote
/// filesystem paths, join URLs, and bridge tokens (`SliccProcess`,
/// `SliccCliDownloader`, `DebugBuildCreator` all interpolate them), and a RUM
/// beacon is an outbound network payload.
enum LauncherErrorReport {
    /// Stable `source` values. Keep them in sync with the dashboards that
    /// filter on them.
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

    /// Longest `target` we send. Long enough to keep an OS error message
    /// intelligible, short enough that a beacon stays a beacon.
    static let maxTargetLength = 120

    static func report(_ operation: Operation, _ error: Error) {
        let mapping = mapping(operation: operation, error: error)
        Optel.shared.sample(.error, source: mapping.source, target: mapping.target)
    }

    /// Builds the beacon payload. Exposed for tests so the redaction contract
    /// is asserted without a network round-trip.
    static func mapping(operation: Operation, error: Error) -> OptelErrorMapping {
        let derived = OptelErrorMapping.from(error: error)
        return OptelErrorMapping(
            source: "sliccstart:\(operation.rawValue)",
            target: redact("\(derived.source): \(derived.target)")
        )
    }

    /// Strips the identifying parts of an error message: URLs (a join URL
    /// carries the session secret), absolute paths (home directory reveals the
    /// user name), and `token`/`secret`-style key-value pairs. Whitespace is
    /// collapsed and the result truncated so a beacon stays bounded.
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

    /// A malformed literal here would be a programming error, but a beacon must
    /// never crash the launcher, so an uncompilable pattern is dropped rather
    /// than force-unwrapped.
    private static let redactionPatterns: [RedactionPattern] = [
        // Key-value secrets first: they can sit inside a URL or a path, and the
        // coarser rules below would otherwise swallow the whole match.
        (#"(?i)\b(token|secret|password|key)\b\s*[:=]\s*\S+"#, "$1=<redacted>"),
        (#"[a-zA-Z][a-zA-Z0-9+.-]*://\S*"#, "<url>"),
        (#"(?:/[^\s/:]+){2,}/?"#, "<path>"),
    ].compactMap { expression, replacement in
        guard let regex = try? NSRegularExpression(pattern: expression) else { return nil }
        return RedactionPattern(regex: regex, replacement: replacement)
    }
}
