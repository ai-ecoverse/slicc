import Foundation







struct RawHeaderPair: Equatable, Sendable {
    let name: String
    let value: String

    init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }
}

typealias RawHeaderList = [RawHeaderPair]


struct RawFetchRequestHead: Equatable, Sendable {
    let url: String
    let method: String
    let headers: RawHeaderList
}


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
    
    static let bridgeRequestBodyCap = 256 * 1024 * 1024
    static let hmacSignHeader = "x-slicc-hmac-sign"

    
    
    
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

    
    static func stripRequestHeaders(_ headers: RawHeaderList) -> RawHeaderList {
        let named = connectionTokens(headers)
        return headers.filter {
            let lower = $0.name.lowercased()
            return !requestSkipHeaders.contains(lower) && !named.contains(lower)
        }
    }

    
    
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

    
    
    
    
    
    static func acceptEncoding(for folded: RawHeaderList) -> String {
        let ranged = folded.contains { $0.name == "range" || $0.name == "if-range" }
        return ranged ? "identity" : acceptEncoding
    }

    
    private static func codings(_ headers: RawHeaderList) -> [String] {
        headers.filter { $0.name.lowercased() == "content-encoding" }
            .flatMap { $0.value.split(separator: ",") }
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
    }

    
    static func codingsWereDecoded(_ headers: RawHeaderList, decodedCodings: Set<String>) -> Bool {
        let listed = codings(headers).filter { $0 != "identity" }
        return !listed.isEmpty && listed.allSatisfy { decodedCodings.contains($0) }
    }

    
    
    
    
    
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

    
    static func responseHasBody(method: String, status: Int) -> Bool {
        method.uppercased() != "HEAD" && !nullBodyStatuses.contains(status)
    }

    
    static func isDecodedPartialResponse(status: Int, headers: RawHeaderList, decodedCodings: Set<String>) -> Bool {
        status == 206 && codingsWereDecoded(headers, decodedCodings: decodedCodings)
    }

    
    
    
    
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

    
    private static func jsonString(_ value: Any) -> String? {
        guard !(value is NSNumber) else { return nil }
        return value as? String
    }

    private static let tokenCharacters = Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

    
    static func isToken(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { tokenCharacters.contains($0) }
    }

    
    
    
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

    
    static func probeReplyJSON(maxRequestBodyBytes: Int) -> String {
        "{\"rawFetch\":\(protocolVersion),\"requestBodyStreaming\":true,\"maxRequestBodyBytes\":\(maxRequestBodyBytes)}"
    }
}
