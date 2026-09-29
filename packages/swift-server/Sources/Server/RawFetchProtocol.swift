import Foundation

// Raw-mode fetch-proxy contract (#3571), swift-server's side. The contract
// lives in `@slicc/shared-ts` `raw-fetch-protocol.ts`; this file ports the
// parts the bridge hop needs, and `CrossImplementationTests` pins them against
// the TypeScript output (`packages/shared-ts/tests/cross-impl-vectors.test.ts`).

/// One entry of an ordered header list. Repeats stay separate entries.
struct RawHeaderPair: Equatable, Sendable {
    let name: String
    let value: String

    init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }
}

typealias RawHeaderList = [RawHeaderPair]

/// What the caller wants sent upstream (`RawFetchRequestHead`).
struct RawFetchRequestHead: Equatable, Sendable {
    let url: String
    let method: String
    let headers: RawHeaderList
}

/// What the upstream answered, before the body (`RawFetchResponseHead`).
struct RawFetchResponseHead: Equatable, Sendable {
    let status: Int
    let statusText: String
    let headers: RawHeaderList
    let url: String
}

enum RawFetchProtocol {
    static let requestHeader = "X-Slicc-Raw-Request"
    static let probeHeader = "X-Slicc-Raw-Probe"
    static let protocolVersion = 1
    static let contentType = "application/vnd.slicc.raw-fetch"
    /// `RAW_FETCH_BRIDGE_REQUEST_BODY_CAP`: the ceiling on buffered uploads.
    static let bridgeRequestBodyCap = 256 * 1024 * 1024
    static let hmacSignHeader = "x-slicc-hmac-sign"

    /// The codings AsyncHTTPClient's decompressor undoes. It has no brotli,
    /// so unlike node-server (`gzip, deflate, br`) this float never offers
    /// `br`: the contract says a float asks for exactly what it decodes.
    static let decodedCodings: Set<String> = ["gzip", "deflate"]
    static let acceptEncoding = "gzip, deflate"

    private static let requestSkipHeaders: Set<String> = [
        "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding",
        "upgrade", "host", "content-length", "accept-encoding", "expect",
    ]
    private static let responseSkipHeaders: Set<String> = [
        "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
    ]
    private static let nullBodyStatuses: Set<Int> = [101, 103, 204, 205, 304]

    /// Tokens a `Connection` header names, lowercased.
    private static func connectionTokens(_ headers: RawHeaderList) -> Set<String> {
        var tokens = Set<String>()
        for pair in headers where pair.name.lowercased() == "connection" {
            for token in pair.value.split(separator: ",") {
                let trimmed = token.trimmingCharacters(in: .whitespaces).lowercased()
                if !trimmed.isEmpty { tokens.insert(trimmed) }
            }
        }
        return tokens
    }

    /// `stripRawRequestHeaders`: drop hop-by-hop and float-owned headers, keeping order.
    static func stripRequestHeaders(_ headers: RawHeaderList) -> RawHeaderList {
        let named = connectionTokens(headers)
        return headers.filter {
            let lower = $0.name.lowercased()
            return !requestSkipHeaders.contains(lower) && !named.contains(lower)
        }
    }

    /// `foldRawRequestHeaders`: one lowercase entry per name, in first-seen
    /// order. Repeats join with `, `, except `Cookie`, which joins with `; `.
    static func foldRequestHeaders(_ headers: RawHeaderList) -> RawHeaderList {
        var order: [String] = []
        var values: [String: String] = [:]
        for pair in headers {
            let lower = pair.name.lowercased()
            if let prior = values[lower] {
                values[lower] = prior + (lower == "cookie" ? "; " : ", ") + pair.value
            } else {
                order.append(lower)
                values[lower] = pair.value
            }
        }
        return order.map { RawHeaderPair($0, values[$0] ?? "") }
    }

    /// The `Accept-Encoding` this float sends for these folded headers. A
    /// ranged request must not be offered a compressed coding (its
    /// `Content-Range` would count bytes the caller never sees). Node's fetch
    /// sends `identity` on its own for `Range`; AsyncHTTPClient's decompressor
    /// would add `deflate, gzip` instead, so it is spelled out here.
    static func acceptEncoding(for folded: RawHeaderList) -> String {
        let ranged = folded.contains { $0.name == "range" || $0.name == "if-range" }
        return ranged ? "identity" : acceptEncoding
    }

    /// Content codings listed across every `Content-Encoding` field.
    private static func codings(_ headers: RawHeaderList) -> [String] {
        headers.filter { $0.name.lowercased() == "content-encoding" }
            .flatMap { $0.value.split(separator: ",") }
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
    }

    /// `codingsWereDecoded`: every listed non-identity coding is one the float undid.
    static func codingsWereDecoded(_ headers: RawHeaderList, decodedCodings: Set<String>) -> Bool {
        let listed = codings(headers).filter { $0 != "identity" }
        return !listed.isEmpty && listed.allSatisfy { decodedCodings.contains($0) }
    }

    /// What AsyncHTTPClient did to a body. Its decompressor looks only at the
    /// FIRST listed coding: a lone `gzip`/`deflate` is undone, anything
    /// else stays encoded, and a stack such as `gzip, br` comes out with just
    /// the first layer removed. That last case matches no header the caller
    /// could be given, so the route refuses it.
    enum UpstreamDecoding: Equatable {
        case untouched
        case decoded
        case partiallyDecoded
    }

    static func upstreamDecoding(_ headers: RawHeaderList) -> UpstreamDecoding {
        let listed = codings(headers)
        guard let first = listed.first, decodedCodings.contains(first) else { return .untouched }
        return listed.dropFirst().allSatisfy { $0 == "identity" } ? .decoded : .partiallyDecoded
    }

    /// `rawResponseHasBody`.
    static func responseHasBody(method: String, status: Int) -> Bool {
        method.uppercased() != "HEAD" && !nullBodyStatuses.contains(status)
    }

    /// `isDecodedPartialResponse`: a 206 whose coding the float undid.
    static func isDecodedPartialResponse(status: Int, headers: RawHeaderList, decodedCodings: Set<String>) -> Bool {
        status == 206 && codingsWereDecoded(headers, decodedCodings: decodedCodings)
    }

    /// `rawResponseHeaders`: the head a raw caller sees. Hop-by-hop fields and
    /// the ones `Connection` names go. A bodiless response keeps
    /// `Content-Encoding`/`Content-Length` as sent; otherwise a decoded coding
    /// drops both, and a rewritten body drops `Content-Length`.
    static func responseHeaders(
        method: String,
        status: Int,
        headers: RawHeaderList,
        bodyRewritten: Bool,
        decodedCodings: Set<String>
    ) -> RawHeaderList {
        let named = connectionTokens(headers)
        let withoutHop = headers.filter {
            let lower = $0.name.lowercased()
            return !responseSkipHeaders.contains(lower) && !named.contains(lower)
        }
        guard responseHasBody(method: method, status: status) else { return withoutHop }
        let encoding = withoutHop.filter { $0.name.lowercased() == "content-encoding" }
            .map(\.value).joined(separator: ",")
        let decoded = codingsWereDecoded(withoutHop, decodedCodings: decodedCodings)
        let dropLength = decoded || bodyRewritten
        return withoutHop.filter {
            switch $0.name.lowercased() {
            case "content-length": return !dropLength
            case "content-encoding":
                return !decoded && encoding.trimmingCharacters(in: .whitespaces).lowercased() != "identity"
            default: return true
            }
        }
    }

    /// `rawUploadStreams`: text bodies are buffered so secrets in them can be
    /// unmasked, HMAC-signed ones so they can be signed, and small ones of
    /// known length because holding them costs nothing.
    static let streamThresholdBytes = 8 * 1024 * 1024

    static func uploadStreams(headers: RawHeaderList, bodyLength: Int?, canStream: Bool) -> Bool {
        guard canStream else { return false }
        let folded = foldRequestHeaders(headers)
        if folded.contains(where: { $0.name == hmacSignHeader }) { return false }
        let contentType = folded.first { $0.name == "content-type" }?.value ?? ""
        if isTextRequestContentType(contentType) { return false }
        guard let bodyLength else { return true }
        return bodyLength >= streamThresholdBytes
    }

    /// `decodeRawRequestHead`: `nil` when the JSON is not a request head.
    static func decodeRequestHead(_ value: String) -> RawFetchRequestHead? {
        guard let data = value.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let url = object["url"] as? String,
            let method = object["method"] as? String,
            isToken(method),
            let rawHeaders = object["headers"] as? [Any]
        else { return nil }
        var headers: RawHeaderList = []
        for entry in rawHeaders {
            guard let pair = entry as? [Any], pair.count == 2,
                let name = jsonString(pair[0]), let value = jsonString(pair[1])
            else { return nil }
            headers.append(RawHeaderPair(name, value))
        }
        return RawFetchRequestHead(url: url, method: method, headers: headers)
    }

    /// A JSON string, not a number or bool bridged to `NSString`.
    private static func jsonString(_ value: Any) -> String? {
        guard !(value is NSNumber) else { return nil }
        return value as? String
    }

    private static let tokenCharacters = Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

    /// RFC 9110 `token`, the shape a method must have.
    static func isToken(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { tokenCharacters.contains($0) }
    }

    /// `encodeRawResponseFrame`: a big-endian u32 length, then the UTF-8 JSON
    /// of the head, byte-identical to `JSON.stringify` (same key order, same
    /// escapes) so both floats emit the same frame.
    static func encodeResponseFrame(_ head: RawFetchResponseHead) -> [UInt8] {
        let headers = head.headers.map { "[\(jsonLiteral($0.name)),\(jsonLiteral($0.value))]" }
        let json =
            "{\"status\":\(head.status),\"statusText\":\(jsonLiteral(head.statusText)),"
            + "\"headers\":[\(headers.joined(separator: ","))],\"url\":\(jsonLiteral(head.url))}"
        let body = Array(json.utf8)
        let length = UInt32(body.count)
        return [
            UInt8(length >> 24 & 0xff), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff),
        ] + body
    }

    /// A JSON string literal as `JSON.stringify` writes it.
    static func jsonLiteral(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    /// The probe reply body (`RawFetchProbeReply`).
    static func probeReplyJSON(maxRequestBodyBytes: Int) -> String {
        "{\"rawFetch\":\(protocolVersion),\"requestBodyStreaming\":true,\"maxRequestBodyBytes\":\(maxRequestBodyBytes)}"
    }
}
