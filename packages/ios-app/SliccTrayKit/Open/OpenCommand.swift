import Foundation

/// Stable terminal exit contract for iOS `open` requests.
///
/// 0 success; 64 usage; 65 invalid URL; 69 unavailable destination;
/// 77 denied; 124 approval timeout; 127 unsupported verb; 130 cancelled.
public enum OpenExecExitCode: Int, Sendable {
    case success = 0
    case usage = 64
    case invalidURL = 65
    case unavailable = 69
    case denied = 77
    case timeout = 124
    case unsupportedVerb = 127
    case cancelled = 130
}

public enum OpenCommandMode: String, Codable, Sendable {
    case standard
    case universal
    case xCallback
}

/// Exact persistent grant key. Query and fragment values are deliberately absent.
/// The first percent-encoded path component is kept verbatim, so crafted escaping
/// cannot turn a grant for one action prefix into a grant for another.
public struct OpenGrantScope: Codable, Hashable, Sendable {
    public let scheme: String
    public let authority: String
    public let actionPrefix: String

    public init(scheme: String, authority: String, actionPrefix: String) {
        self.scheme = scheme
        self.authority = authority
        self.actionPrefix = actionPrefix
    }
}

public struct ParsedOpenCommand: Equatable, Sendable {
    public let mode: OpenCommandMode
    public let url: URL
    public let scope: OpenGrantScope
    public let displayScheme: String
    public let displayHostAction: String
    public var returnsResultData: Bool { mode == .xCallback }
}

public struct OpenCommandParseError: Error, Equatable, Sendable {
    public let exitCode: OpenExecExitCode
    public let message: String

    fileprivate init(_ exitCode: OpenExecExitCode, _ message: String) {
        self.exitCode = exitCode
        self.message = message
    }
}

public enum OpenCommandParser {
    private static let disallowedShellScalars = CharacterSet(charactersIn: ";|`$<>\\")

    /// Parses one deliberately tiny grammar without invoking or approximating a shell:
    /// `open [--universal|--x-callback] <opaque-url>`.
    ///
    /// The URL is the untouched remainder, not a token stream. The sole quoting
    /// allowance removes one matching outer `'` or `"` pair; any remaining quote,
    /// escape, whitespace, or shell separator is rejected rather than interpreted.
    public static func parse(_ command: String) throws -> ParsedOpenCommand {
        guard !command.isEmpty else { throw usage("open requires one URL") }
        guard let separator = command.firstIndex(of: " ") else {
            if command == "open" { throw usage("open requires one URL") }
            throw unsupported(command)
        }

        let verb = String(command[..<separator])
        guard verb == "open" else { throw unsupported(verb) }
        var remainder = String(command[command.index(after: separator)...])
        guard !remainder.isEmpty, !remainder.hasPrefix(" ") else {
            throw usage("open requires exactly one URL argument")
        }

        let flagModes: [(String, OpenCommandMode)] = [
            ("--universal", .universal),
            ("--x-callback", .xCallback),
        ]
        var mode = OpenCommandMode.standard
        for (flag, candidateMode) in flagModes where remainder.hasPrefix(flag + " ") {
            mode = candidateMode
            remainder.removeFirst(flag.count + 1)
            break
        }
        guard !remainder.hasPrefix("-") else {
            throw usage("open accepts only --universal or --x-callback")
        }

        let rawURL = try stripOneQuoteLayer(remainder)
        try validateOpaqueURLArgument(rawURL)
        return try parsedURL(rawURL, mode: mode)
    }

    private static func stripOneQuoteLayer(_ value: String) throws -> String {
        guard let first = value.first else { throw usage("open requires one URL") }
        guard first == "'" || first == "\"" else { return value }
        guard value.count >= 2, value.last == first else {
            throw usage("open URL has unmatched surrounding quotes")
        }
        let stripped = String(value.dropFirst().dropLast())
        guard !stripped.isEmpty else { throw usage("open requires one URL") }
        return stripped
    }

    private static func validateOpaqueURLArgument(_ value: String) throws {
        guard value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            throw usage("open URL must be one opaque argument")
        }
        guard !value.contains("'") && !value.contains("\"") else {
            throw usage("open strips at most one matching quote layer")
        }
        guard value.rangeOfCharacter(from: disallowedShellScalars) == nil else {
            throw usage("open does not interpret shell metacharacters")
        }
    }

    private static func parsedURL(_ value: String, mode: OpenCommandMode) throws
        -> ParsedOpenCommand
    {
        guard let components = URLComponents(string: value),
            let rawScheme = components.scheme,
            !rawScheme.isEmpty,
            components.user == nil,
            components.password == nil,
            let url = components.url
        else {
            throw invalidURL()
        }
        let scheme = rawScheme.lowercased()
        guard !["data", "file", "javascript"].contains(scheme) else { throw invalidURL() }
        guard mode != .universal || scheme == "https" else {
            throw OpenCommandParseError(.invalidURL, "--universal requires an https URL")
        }

        var authority = (components.percentEncodedHost ?? "").lowercased()
        if let port = components.port { authority += ":\(port)" }
        let action = components.percentEncodedPath.split(separator: "/").first.map(String.init) ?? ""
        let decodedAction = action.removingPercentEncoding ?? action
        guard decodedAction != ".", decodedAction != "..", !authority.isEmpty || !action.isEmpty
        else { throw invalidURL() }

        let hostAction: String
        if authority.isEmpty {
            hostAction = action
        } else if action.isEmpty {
            hostAction = authority
        } else {
            hostAction = authority + "/" + action
        }
        return ParsedOpenCommand(
            mode: mode,
            url: url,
            scope: OpenGrantScope(
                scheme: scheme, authority: authority, actionPrefix: action),
            displayScheme: scheme,
            displayHostAction: hostAction)
    }

    private static func usage(_ message: String) -> OpenCommandParseError {
        OpenCommandParseError(.usage, message)
    }

    private static func unsupported(_ verb: String) -> OpenCommandParseError {
        OpenCommandParseError(
            .unsupportedVerb,
            "unsupported command '\(verb)'; open is the only supported command")
    }

    private static func invalidURL() -> OpenCommandParseError {
        OpenCommandParseError(.invalidURL, "open requires a valid external URL")
    }
}
