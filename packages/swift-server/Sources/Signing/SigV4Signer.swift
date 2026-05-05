import CryptoKit
import Foundation

/// AWS SigV4 v4 signing — swift-server copy.
///
/// **Mirrors `packages/webapp/src/fs/mount/signing-s3.ts` and
/// `packages/node-server/src/secrets/signing-s3.ts`.** All three files
/// implement the same algorithm and must produce byte-identical signatures
/// for the same inputs. The functions/types that must stay aligned across
/// all three implementations:
///
///   - `signSigV4` / `SigV4Signer.sign` — entry point and HMAC chain
///   - `canonicalUri` — path percent-encoding
///   - `canonicalQuery` — query parameter sorting + encoding
///   - `canonicalHeaders` — lowercase + trim + collapse whitespace + sort
///
/// Drift between any of them is caught by all three test suites running
/// the same canonical AWS test vectors:
///
///   - `packages/webapp/tests/fs/mount/signing-s3.test.ts`
///   - `packages/node-server/tests/secrets/signing-s3.test.ts`
///   - `packages/swift-server/Tests/SigV4SignerTests.swift`
///
/// The AWS service-agnostic vectors only exercise empty queries; non-empty
/// query parity (e.g. R2 listing's `?list-type=2&prefix=...`) is exercised
/// by the upstream-success handler tests in `SignAndForwardTests`.
///
/// If you change one, change the others and verify all three suites pass.
///
/// Pure function — given a request + credentials + region + service +
/// clock, returns the same request with an `Authorization` header attached
/// (and `x-amz-date`, optionally `x-amz-content-sha256` for `service == "s3"`,
/// optionally `x-amz-security-token` for STS credentials).
///
/// Uses `CryptoKit` (Apple SDK) for HMAC-SHA256 and SHA-256.

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

/// HTTP methods accepted by the SigV4 signer and the sign-and-forward
/// handlers. Closed enum so the call site can switch exhaustively and the
/// validation surface in `SignAndForward` doesn't have to maintain a
/// parallel string set.
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

    /// Signs `request` and returns a copy with the SigV4 headers added.
    /// `service` is "s3" for our usual case; the AWS canonical test
    /// vectors use "service" (literal) and gate on that name to skip the
    /// `x-amz-content-sha256` header.
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

        // Build the headers dict that participates in the canonical request.
        // Strategy mirrors signing-s3.ts: shallow-copy the caller's headers,
        // overlay `host` (from the URL if not already present) and
        // `x-amz-date`, then conditionally add `x-amz-content-sha256` and
        // `x-amz-security-token`. Drop any mixed-case "Host" so it doesn't
        // double-count after lowercasing.
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
        // Remove a mixed-case "Host" key if one was passed in alongside our
        // lowercased "host" — JS does `delete headers.Host` for the same
        // reason. Iterate explicitly because Swift dict access is
        // case-sensitive.
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

        // Derive signing key: kDate, kRegion, kService, kSigning.
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

// MARK: - Canonicalization helpers

extension SigV4Signer {

    /// Percent-encode characters NOT in RFC 3986 unreserved set
    /// (`A-Z a-z 0-9 - _ . ~`). Matches `encodeURIComponent(s).replace(/[!'()*]/g, ...)`
    /// in the JS signer — which together exclude exactly the unreserved set.
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
        // A-Z, a-z, 0-9
        if b >= 0x41 && b <= 0x5A { return true }
        if b >= 0x61 && b <= 0x7A { return true }
        if b >= 0x30 && b <= 0x39 { return true }
        // - _ . ~
        return b == 0x2D || b == 0x5F || b == 0x2E || b == 0x7E
    }

    private static let hexDigits: [Character] = Array("0123456789ABCDEF")

    private static func uppercaseHexByte(_ b: UInt8) -> String {
        let hi = hexDigits[Int(b >> 4)]
        let lo = hexDigits[Int(b & 0x0F)]
        return "\(hi)\(lo)"
    }

    /// Canonicalize the URI: percent-encode each path segment per RFC 3986
    /// except preserve `/`. Mirrors `canonicalUri` in signing-s3.ts.
    static func canonicalUri(_ url: URL) -> String {
        // Match JS `url.pathname` — the URL parser leaves percent-encoded
        // characters as-is. Swift's URLComponents.path returns the decoded
        // form; use percentEncodedPath to get JS-equivalent behavior.
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        if path.isEmpty { return "/" }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let encoded = segments.map(percentEncode)
        let result = encoded.joined(separator: "/")
        return result.isEmpty ? "/" : result
    }

    /// Build the canonical query string: parse query params, sort by key
    /// then by value, percent-encode keys and values per RFC 3986.
    static func canonicalQuery(_ url: URL) -> String {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let queryItems = components.percentEncodedQueryItems, !queryItems.isEmpty
        else {
            return ""
        }
        // Decode each percent-encoded item back to raw, then re-encode with
        // our strict RFC 3986 set so the output matches the JS signer
        // (which `encodeURIComponent`s already-decoded URLSearchParams entries).
        let pairs: [(String, String)] = queryItems.map { item in
            let key = item.name.removingPercentEncoding ?? item.name
            let value = (item.value?.removingPercentEncoding) ?? item.value ?? ""
            return (key, value)
        }
        let sorted = pairs.sorted { lhs, rhs in
            if lhs.0 != rhs.0 { return lhs.0 < rhs.0 }
            return lhs.1 < rhs.1
        }
        return sorted
            .map { "\(percentEncode($0.0))=\(percentEncode($0.1))" }
            .joined(separator: "&")
    }

    /// Canonicalize headers: lowercase keys, trim and collapse internal
    /// whitespace, sort by key. Returns both the canonical string (each
    /// `key:value\n`) and the semicolon-joined signed-headers list.
    static func canonicalHeaders(_ headers: [String: String]) -> (canonical: String, signed: String) {
        let normalized: [(key: String, value: String)] = headers.map { (key, value) in
            let lowerKey = key.lowercased()
            // Trim whitespace + newlines and collapse internal runs to a
            // single space. Matches JS `value.trim().replace(/\s+/g, ' ')`,
            // where `\s` includes newlines — so we use `whitespacesAndNewlines`
            // here, not `.whitespaces` (which omits newlines on Apple platforms).
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

// MARK: - Crypto helpers

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

// MARK: - Date formatting

extension SigV4Signer {

    private static let utcCalendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    /// `YYYYMMDD` per AWS SigV4.
    static func formatYMD(_ date: Date) -> String {
        let c = utcCalendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d%02d%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0
        )
    }

    /// `YYYYMMDDTHHMMSSZ` per AWS SigV4.
    static func formatISO8601(_ date: Date) -> String {
        let c = utcCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d%02d%02dT%02d%02d%02dZ",
            c.year ?? 0, c.month ?? 0, c.day ?? 0,
            c.hour ?? 0, c.minute ?? 0, c.second ?? 0
        )
    }
}
