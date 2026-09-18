import Foundation
import HTTPTypes



















enum BridgeSecurity {
    
    
    
    
    static let allowedOrigins: [String] = [
        "https://www.sliccy.ai",
        "https://slicc-tray-hub-staging.minivelos.workers.dev",
        "http://localhost:5710",
        "http://127.0.0.1:5710",
    ]

    
    
    
    
    
    
    static let devAllowedOrigins: Set<String> = parseDevAllowedOrigins(
        ProcessInfo.processInfo.environment["BRIDGE_DEV_ALLOWED_ORIGINS"]
    )

    
    
    static func parseDevAllowedOrigins(_ raw: String?) -> Set<String> {
        guard let raw, !raw.isEmpty else { return [] }
        var set = Set<String>()
        for entry in raw.split(separator: ",", omittingEmptySubsequences: false) {
            if let normalized = normalizeDevOrigin(String(entry)) {
                set.insert(normalized)
            }
        }
        return set
    }

    
    
    
    static func normalizeDevOrigin(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        var candidate = trimmed.lowercased()
        while candidate.hasSuffix("/") {
            candidate = String(candidate.dropLast())
        }
        if candidate.isEmpty { return nil }
        guard let components = URLComponents(string: candidate),
            let scheme = components.scheme, !scheme.isEmpty,
            let host = components.host, !host.isEmpty
        else {
            return nil
        }
        return candidate
    }

    
    static let subprotocolPrefix = "slicc.bridge.v1."

    
    static let tokenQueryParam = "bridgeToken"

    
    static let wsQueryParam = "bridge"

    
    
    
    
    
    
    
    static let corsBaseAllowHeaders: [String] = [
        "Content-Type",
        "X-Slicc-Raw-Body",
        "X-Session-Id",
        "X-Bridge-Token",
        "Authorization",
        "X-Target-URL",
        "X-Proxy-Cookie",
        "X-Proxy-Origin",
        "X-Proxy-Referer",
    ]

    
    
    
    
    
    
    
    
    
    
    
    static let corsExposeHeaders =
        "Link, X-Proxy-Error, X-Proxy-Set-Cookie, Mcp-Session-Id, MCP-Protocol-Version"

    
    
    
    
    
    
    
    
    static let corsAllowMethods =
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT, COPY, MOVE, LOCK, UNLOCK"

    
    
    
    
    
    
    static let bridgeTokenHeader = "X-Bridge-Token"

    
    
    
    
    
    
    
    
    
    static func resolveCorsAllowHeaders(_ requestHeadersHeader: String?) -> String {
        guard let requestHeadersHeader, !requestHeadersHeader.isEmpty else {
            return corsBaseAllowHeaders.joined(separator: ", ")
        }
        var seen = Set(corsBaseAllowHeaders.map { $0.lowercased() })
        var extras: [String] = []
        for raw in requestHeadersHeader.split(separator: ",", omittingEmptySubsequences: false) {
            let name = raw.trimmingCharacters(in: .whitespaces)
            if name.isEmpty { continue }
            let lower = name.lowercased()
            if seen.contains(lower) { continue }
            seen.insert(lower)
            extras.append(name)
        }
        if extras.isEmpty { return corsBaseAllowHeaders.joined(separator: ", ") }
        return (corsBaseAllowHeaders + extras).joined(separator: ", ")
    }

    
    
    
    enum RejectionReason: String, Sendable {
        case originNotAllowed = "origin-not-allowed"
        case subprotocolMissingOrMismatched = "subprotocol-missing-or-mismatched"
    }

    struct UpgradeGateResult: Sendable, Equatable {
        let ok: Bool
        
        
        let acceptedSubprotocol: String?
        
        let reason: RejectionReason?
    }

    
    
    
    
    
    
    static func isAllowedOrigin(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return false }
        if allowedOrigins.contains(origin) { return true }
        if devAllowedOrigins.isEmpty { return false }
        guard let normalized = normalizeDevOrigin(origin) else { return false }
        return devAllowedOrigins.contains(normalized)
    }

    
    
    
    static func isLoopbackHostname(_ hostname: String) -> Bool {
        guard !hostname.isEmpty else { return false }
        
        
        let host: String
        if hostname.hasPrefix("["), hostname.hasSuffix("]") {
            host = String(hostname.dropFirst().dropLast())
        } else {
            host = hostname
        }
        if host == "localhost" || host == "::1" { return true }
        
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4, octets[0] == "127" else { return false }
        return octets.allSatisfy { octet in
            octet.count >= 1 && octet.count <= 3 && octet.allSatisfy(\.isNumber)
        }
    }

    
    
    
    
    
    
    
    
    
    
    static func isLoopbackBridgeOrigin(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return false }
        guard let components = URLComponents(string: origin), let host = components.host else {
            return false
        }
        return isLoopbackHostname(host)
    }

    
    
    
    
    
    
    static func validateBridgeToken(_ presented: String?, _ expected: String?) -> Bool {
        guard let expected, !expected.isEmpty else { return false }
        guard let presented, !presented.isEmpty else { return false }
        let a = Array(presented.utf8)
        let b = Array(expected.utf8)
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for index in a.indices {
            diff |= a[index] ^ b[index]
        }
        return diff == 0
    }

    
    
    
    static func mintToken() -> String {
        UUID().uuidString
    }

    
    
    static func parseSubprotocolHeader(_ header: String?) -> [String] {
        guard let header, !header.isEmpty else { return [] }
        return
            header
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    
    
    
    static func selectSubprotocol(_ protocols: [String], expectedToken: String) -> String? {
        guard !expectedToken.isEmpty else { return nil }
        let expected = subprotocolPrefix + expectedToken
        return protocols.contains(expected) ? expected : nil
    }

    
    
    
    
    static func validateUpgrade(
        origin: String?,
        subprotocolHeader: String?,
        expectedToken: String
    ) -> UpgradeGateResult {
        if !isAllowedOrigin(origin) {
            return UpgradeGateResult(ok: false, acceptedSubprotocol: nil, reason: .originNotAllowed)
        }
        let protocols = parseSubprotocolHeader(subprotocolHeader)
        guard let accepted = selectSubprotocol(protocols, expectedToken: expectedToken) else {
            return UpgradeGateResult(
                ok: false,
                acceptedSubprotocol: nil,
                reason: .subprotocolMissingOrMismatched
            )
        }
        return UpgradeGateResult(ok: true, acceptedSubprotocol: accepted, reason: nil)
    }

    
    
    
    
    
    
    
    
    
    
    static func buildCorsHeaders(origin: String?, requestHeadersHeader: String? = nil) -> HTTPFields? {
        guard isAllowedOrigin(origin), let origin else { return nil }
        var fields = HTTPFields()
        fields[HTTPField.Name("Access-Control-Allow-Origin")!] = origin
        fields[HTTPField.Name("Access-Control-Allow-Credentials")!] = "true"
        fields[HTTPField.Name("Access-Control-Allow-Methods")!] = corsAllowMethods
        fields[HTTPField.Name("Access-Control-Allow-Headers")!] = resolveCorsAllowHeaders(requestHeadersHeader)
        fields[HTTPField.Name("Access-Control-Expose-Headers")!] = corsExposeHeaders
        fields[HTTPField.Name("Vary")!] = "Origin, Access-Control-Request-Headers"
        return fields
    }

    
    
    
    static func buildPnaPreflightHeaders() -> HTTPFields {
        var fields = HTTPFields()
        fields[HTTPField.Name("Access-Control-Allow-Private-Network")!] = "true"
        return fields
    }

    
    
    
    
    
    
    
    
    static func preflightMaxAge(_ path: String) -> String {
        path == "/api/hostfs" || path.hasPrefix("/api/hostfs/") ? "7200" : "600"
    }
}
