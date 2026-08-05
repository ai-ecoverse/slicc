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
/// The first validated percent-encoded path component is kept verbatim. Raw path
/// validation applies equally to hierarchical and opaque URLs before scope derivation,
/// so a downstream decoder cannot widen this displayed scope.
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
        guard let separator = command.firstIndex(where: \.isWhitespace) else {
            if command == "open" { throw usage("open requires one URL") }
            throw unsupported(command)
        }

        let verb = String(command[..<separator])
        guard verb == "open" else { throw unsupported(verb) }
        guard command[separator] == " " else {
            throw usage("open requires a space before its URL")
        }
        var remainder = String(command[command.index(after: separator)...])
        guard !remainder.isEmpty, remainder.first?.isWhitespace == false else {
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
        let rawPath = try rawPath(in: value)
        guard rawPath.path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy(pathSegmentIsUnambiguous)
        else {
            throw invalidURL()
        }
        guard let inputComponents = URLComponents(string: value),
            inputComponents.user == nil,
            inputComponents.password == nil,
            let inputURL = inputComponents.url
        else {
            throw invalidURL()
        }
        let canonicalURL = rawPath.isHierarchical ? inputURL.standardized : inputURL
        // Raw segment validation above is the load-bearing check for every URL shape.
        // Foundation standardization is only a secondary check for hierarchical URLs;
        // it deliberately does not normalize opaque custom-scheme paths.
        guard !rawPath.isHierarchical || canonicalURL.absoluteString == value,
            let components = URLComponents(url: canonicalURL, resolvingAgainstBaseURL: false),
            let rawScheme = components.scheme,
            !rawScheme.isEmpty,
            components.user == nil,
            components.password == nil
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
        guard !authority.isEmpty || !action.isEmpty else { throw invalidURL() }

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
            url: canonicalURL,
            scope: OpenGrantScope(
                scheme: scheme, authority: authority, actionPrefix: action),
            displayScheme: scheme,
            displayHostAction: hostAction)
    }

    /// Extract the raw path after the scheme and optional authority. This does not
    /// ask Foundation to interpret the path, so opaque and hierarchical URLs receive
    /// the same segment checks.
    private static func rawPath(in value: String) throws -> (path: String, isHierarchical: Bool) {
        guard let schemeEnd = value.firstIndex(of: ":"), schemeEnd != value.startIndex else {
            throw invalidURL()
        }
        var pathStart = value.index(after: schemeEnd)
        let isHierarchical = value[pathStart...].hasPrefix("/")
        if value[pathStart...].hasPrefix("//") {
            let authorityStart = value.index(pathStart, offsetBy: 2)
            guard let delimiter = value[authorityStart...].firstIndex(where: { "/?#".contains($0) })
            else {
                return ("", true)
            }
            guard value[delimiter] == "/" else { return ("", true) }
            pathStart = delimiter
        }
        let pathEnd = value[pathStart...].firstIndex(where: { $0 == "?" || $0 == "#" })
            ?? value.endIndex
        return (String(value[pathStart..<pathEnd]), isHierarchical)
    }

    /// Decode each raw segment until no escape remains. Literal traversal is rejected,
    /// and any decode round producing traversal, a path delimiter, or another percent
    /// escape is invalid. Rejecting the latter makes arbitrary encoding depth fail closed.
    private static func pathSegmentIsUnambiguous(_ rawSegment: Substring) -> Bool {
        var segment = String(rawSegment)
        guard segment != ".", segment != "..", !segment.contains("\\") else { return false }
        while segment.contains("%") {
            guard let decoded = segment.removingPercentEncoding, decoded != segment else {
                return false
            }
            guard decoded != ".", decoded != "..",
                !decoded.contains("/"), !decoded.contains("\\"), !decoded.contains("%")
            else {
                return false
            }
            segment = decoded
        }
        return true
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
