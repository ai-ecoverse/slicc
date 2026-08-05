import Foundation
import Security

/// Bounds mirrored from `packages/shared-ts/src/tray-sync-protocol.ts`.
public enum OpenCallbackLimits {
    public static let parameterCount = 16
    public static let serializedBytes = 16 * 1024
}

public enum OpenCallbackStatus: String, Codable, Sendable {
    case success
    case error
    case cancel
}

public struct OpenCallbackParameter: Codable, Equatable, Sendable {
    public let name: String
    public let value: String
}

/// Stable stdout contract parsed by the requesting agent.
///
/// Every callback writes one JSON object shaped as
/// `{ "parameters": [{ "name": String, "value": String }], "status": String }`.
/// An array preserves duplicate parameter names and callback order.
public struct OpenCallbackResult: Codable, Equatable, Sendable {
    public let status: OpenCallbackStatus
    public let parameters: [OpenCallbackParameter]
}

public struct OpenLaunchRequest: Equatable, Sendable {
    public let requestId: String
    public let url: URL
    public let mode: OpenCommandMode
}

public enum OpenCallbackDecodeOutcome: Equatable, Sendable {
    case ignored
    case overflow(requestId: String, nonce: String)
    case result(requestId: String, nonce: String, result: OpenCallbackResult, json: Data)
}

public enum OpenCallbackCodec {
    public static let scheme = "slicc-open-callback"
    private static let host = "x-callback"
    private static let requestIdKey = "requestId"
    private static let nonceKey = "nonce"
    private static let callbackKeys = Set(["x-success", "x-error", "x-cancel"])
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    public static func makeNonce(byteCount: Int = 32) throws -> String {
        precondition(byteCount >= 32, "callback nonces require at least 256 bits")
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes) == errSecSuccess else {
            throw OpenCallbackError.randomnessUnavailable
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func constantTimeNonceEqual(_ expected: String, _ candidate: String) -> Bool {
        let expectedBytes = Array(expected.utf8)
        let candidateBytes = Array(candidate.utf8)
        var difference = expectedBytes.count ^ candidateBytes.count
        for index in 0..<max(expectedBytes.count, candidateBytes.count) {
            let expectedByte = index < expectedBytes.count ? expectedBytes[index] : 0
            let candidateByte = index < candidateBytes.count ? candidateBytes[index] : 0
            difference |= Int(expectedByte ^ candidateByte)
        }
        return difference == 0
    }

    /// Adds app-owned callback destinations without re-encoding any non-callback
    /// destination byte. Leader-supplied callback keys are removed at every
    /// percent-encoding depth before the three trusted values are appended.
    public static func launchURL(
        for command: ParsedOpenCommand,
        requestId: String,
        nonce: String
    ) throws -> URL {
        guard command.mode == .xCallback else { return command.url }
        let callbacks = try OpenCallbackStatus.allCasesForConstruction.map { status in
            let callback = try callbackURL(status: status, requestId: requestId, nonce: nonce)
            return (status.destinationKey, try percentEncode(callback.absoluteString))
        }
        return try replacingCallbackQuery(in: command.url.absoluteString, with: callbacks)
    }

    public static func owns(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
    }

    public static func decode(_ url: URL) -> OpenCallbackDecodeOutcome {
        guard owns(url),
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.host?.lowercased() == host,
            components.user == nil,
            components.password == nil,
            components.port == nil,
            components.fragment == nil,
            let status = status(path: components.path),
            let rawQuery = components.percentEncodedQuery
        else { return .ignored }

        var requestIds: [String] = []
        var nonces: [String] = []
        var parameters: [OpenCallbackParameter] = []
        for field in rawQuery.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = fixedPointDecode(String(pair[0])),
                let value = fixedPointDecode(pair.count == 2 ? String(pair[1]) : "")
            else { return .ignored }
            switch name {
            case requestIdKey:
                requestIds.append(value)
            case nonceKey:
                nonces.append(value)
            default:
                parameters.append(OpenCallbackParameter(name: name, value: value))
            }
        }
        guard requestIds.count == 1, nonces.count == 1,
            !requestIds[0].isEmpty, !nonces[0].isEmpty
        else { return .ignored }
        let requestId = requestIds[0]
        let nonce = nonces[0]
        guard parameters.count <= OpenCallbackLimits.parameterCount else {
            return .overflow(requestId: requestId, nonce: nonce)
        }

        let result = OpenCallbackResult(status: status, parameters: parameters)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let json = try? encoder.encode(result),
            json.count <= OpenCallbackLimits.serializedBytes
        else { return .overflow(requestId: requestId, nonce: nonce) }
        return .result(requestId: requestId, nonce: nonce, result: result, json: json)
    }

    private static func callbackURL(
        status: OpenCallbackStatus,
        requestId: String,
        nonce: String
    ) throws -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = "/\(status.rawValue)"
        components.queryItems = [
            URLQueryItem(name: requestIdKey, value: requestId),
            URLQueryItem(name: nonceKey, value: nonce),
        ]
        guard let url = components.url else { throw OpenCallbackError.invalidConstruction }
        return url
    }

    private static func replacingCallbackQuery(
        in absoluteString: String,
        with callbacks: [(String, String)]
    ) throws -> URL {
        let fragmentIndex = absoluteString.firstIndex(of: "#")
        let beforeFragment = fragmentIndex.map { String(absoluteString[..<$0]) } ?? absoluteString
        let fragment = fragmentIndex.map { String(absoluteString[$0...]) } ?? ""
        let queryIndex = beforeFragment.firstIndex(of: "?")
        let base = queryIndex.map { String(beforeFragment[..<$0]) } ?? beforeFragment
        let rawQuery = queryIndex.map { String(beforeFragment[beforeFragment.index(after: $0)...]) }
        var fields: [String] = []
        if let rawQuery, !rawQuery.isEmpty {
            for field in rawQuery.split(separator: "&", omittingEmptySubsequences: false) {
                let rawName = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0]
                guard let name = fixedPointDecode(String(rawName)) else {
                    throw OpenCallbackError.invalidConstruction
                }
                if !callbackKeys.contains(name.lowercased()) { fields.append(String(field)) }
            }
        }
        fields.append(contentsOf: callbacks.map { "\($0.0)=\($0.1)" })
        guard let url = URL(string: base + "?" + fields.joined(separator: "&") + fragment) else {
            throw OpenCallbackError.invalidConstruction
        }
        return url
    }

    private static func status(path: String) -> OpenCallbackStatus? {
        guard path.first == "/", !path.dropFirst().contains("/") else { return nil }
        return OpenCallbackStatus(rawValue: String(path.dropFirst()))
    }

    private static func fixedPointDecode(_ raw: String) -> String? {
        var value = raw
        while value.contains("%") {
            guard let decoded = value.removingPercentEncoding, decoded != value else { return nil }
            value = decoded
        }
        return value
    }

    private static func percentEncode(_ value: String) throws -> String {
        guard let encoded = value.addingPercentEncoding(withAllowedCharacters: unreserved) else {
            throw OpenCallbackError.invalidConstruction
        }
        return encoded
    }
}

private enum OpenCallbackError: Error {
    case randomnessUnavailable
    case invalidConstruction
}

extension OpenCallbackStatus {
    fileprivate static let allCasesForConstruction: [OpenCallbackStatus] = [.success, .error, .cancel]

    fileprivate var destinationKey: String {
        switch self {
        case .success: "x-success"
        case .error: "x-error"
        case .cancel: "x-cancel"
        }
    }
}
