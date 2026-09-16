import CryptoKit
import Foundation

public struct SigV4Credentials: Sendable, Equatable {
    public let accessKeyId: String
    public let secretAccessKey: String
    public let sessionToken: String?

    public init(accessKeyId: String, secretAccessKey: String, sessionToken: String? = nil) {
        self.accessKeyId = accessKeyId
        self.secretAccessKey = secretAccessKey
        self.sessionToken = sessionToken
    }
}

public enum SigV4Method: String, Sendable, Equatable, CaseIterable {
    case GET, PUT, POST, DELETE, HEAD
}

public struct SigV4Request: Sendable, Equatable {
    public let method: SigV4Method
    public let url: URL
    public let headers: [String: String]
    public let body: Data?

    public init(method: SigV4Method, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public enum SigV4Signer {

    private static let signedAlgorithm = "AWS4-HMAC-SHA256"
    private static let emptyBodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    public static func sign(
        _ request: SigV4Request,
        credentials: SigV4Credentials,
        region: String,
        service: String = "s3",
        now: Date = Date()
    ) -> SigV4Request {
        let date = formatYMD(now)
        let dateTime = formatISO8601(now)

        let bodyData = request.body ?? Data()
        let bodyHash = bodyData.isEmpty ? emptyBodyHash : sha256Hex(bodyData)

        var headers = request.headers
        let existingHost = headers.first(where: { $0.key.lowercased() == "host" })?.value
        headers["host"] = existingHost ?? (request.url.host ?? "")
        headers["x-amz-date"] = dateTime
        if service == "s3" {
            headers["x-amz-content-sha256"] = bodyHash
        }
        if let sessionToken = credentials.sessionToken {
            headers["x-amz-security-token"] = sessionToken
        }

        for key in headers.keys where key != "host" && key.lowercased() == "host" {
            headers.removeValue(forKey: key)
        }

        let canonicalHeadersResult = canonicalHeaders(headers)
        let canonicalRequest = [
            request.method.rawValue,
            canonicalUri(request.url),
            canonicalQuery(request.url),
            canonicalHeadersResult.canonical,
            canonicalHeadersResult.signed,
            bodyHash,
        ].joined(separator: "\n")

        let credentialScope = "\(date)/\(region)/\(service)/aws4_request"
        let stringToSign = [
            signedAlgorithm,
            dateTime,
            credentialScope,
            sha256Hex(Data(canonicalRequest.utf8)),
        ].joined(separator: "\n")

        let kSecret = Data("AWS4\(credentials.secretAccessKey)".utf8)
        let kDate = hmacSha256(key: kSecret, data: Data(date.utf8))
        let kRegion = hmacSha256(key: kDate, data: Data(region.utf8))
        let kService = hmacSha256(key: kRegion, data: Data(service.utf8))
        let kSigning = hmacSha256(key: kService, data: Data("aws4_request".utf8))
        let signature = hex(hmacSha256(key: kSigning, data: Data(stringToSign.utf8)))

        let authorization =
            "\(signedAlgorithm) Credential=\(credentials.accessKeyId)/\(credentialScope), "
            + "SignedHeaders=\(canonicalHeadersResult.signed), Signature=\(signature)"
        headers["Authorization"] = authorization

        return SigV4Request(method: request.method, url: request.url, headers: headers, body: request.body)
    }
}

extension SigV4Signer {

    static func percentEncode(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.utf8.count)
        for byte in s.utf8 {
            if isUnreserved(byte) {
                out.append(Character(Unicode.Scalar(byte)))
            } else {
                out.append("%")
                out.append(uppercaseHexByte(byte))
            }
        }
        return out
    }

    private static func isUnreserved(_ b: UInt8) -> Bool {

        if b >= 0x41 && b <= 0x5A { return true }
        if b >= 0x61 && b <= 0x7A { return true }
        if b >= 0x30 && b <= 0x39 { return true }

        return b == 0x2D || b == 0x5F || b == 0x2E || b == 0x7E
    }

    private static let hexDigits: [Character] = Array("0123456789ABCDEF")

    private static func uppercaseHexByte(_ b: UInt8) -> String {
        let hi = hexDigits[Int(b >> 4)]
        let lo = hexDigits[Int(b & 0x0F)]
        return "\(hi)\(lo)"
    }

    static func canonicalUri(_ url: URL) -> String {

        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        if path.isEmpty { return "/" }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let encoded = segments.map(percentEncode)
        let result = encoded.joined(separator: "/")
        return result.isEmpty ? "/" : result
    }

    static func canonicalQuery(_ url: URL) -> String {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let queryItems = components.percentEncodedQueryItems, !queryItems.isEmpty
        else {
            return ""
        }

        let pairs: [(String, String)] = queryItems.map { item in
            let key = item.name.removingPercentEncoding ?? item.name
            let value = (item.value?.removingPercentEncoding) ?? item.value ?? ""
            return (key, value)
        }
        let sorted = pairs.sorted { lhs, rhs in
            if lhs.0 != rhs.0 { return lhs.0 < rhs.0 }
            return lhs.1 < rhs.1
        }
        return
            sorted
            .map { "\(percentEncode($0.0))=\(percentEncode($0.1))" }
            .joined(separator: "&")
    }

    static func canonicalHeaders(_ headers: [String: String]) -> (canonical: String, signed: String) {
        let normalized: [(key: String, value: String)] = headers.map { (key, value) in
            let lowerKey = key.lowercased()

            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            let collapsed = trimmed.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            return (lowerKey, collapsed)
        }
        let sorted = normalized.sorted { $0.key < $1.key }
        let canonical = sorted.map { "\($0.key):\($0.value)\n" }.joined()
        let signed = sorted.map { $0.key }.joined(separator: ";")
        return (canonical, signed)
    }
}

extension SigV4Signer {

    static func sha256Hex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return hex(Data(digest))
    }

    static func hmacSha256(key: Data, data: Data) -> Data {
        let mac = HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key))
        return Data(mac)
    }

    static func hex(_ data: Data) -> String {
        var out = ""
        out.reserveCapacity(data.count * 2)
        for byte in data {
            out.append(uppercaseHexByte(byte))
        }
        return out.lowercased()
    }
}

extension SigV4Signer {

    private static let utcCalendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    static func formatYMD(_ date: Date) -> String {
        let c = utcCalendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d%02d%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0
        )
    }

    static func formatISO8601(_ date: Date) -> String {
        let c = utcCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d%02d%02dT%02d%02d%02dZ",
            c.year ?? 0, c.month ?? 0, c.day ?? 0,
            c.hour ?? 0, c.minute ?? 0, c.second ?? 0
        )
    }
}
