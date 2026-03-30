import CommonCrypto
import Foundation

// MARK: - Known Token Prefixes

private let knownPrefixes: [String] = [
    "github_pat_",
    "sk-ant-",
    "Bearer ",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "sk-",
    "pk-",
    "AKIA",
    "ABIA",
    "ACCA",
    "ASIA",
]

// Sorted longest-first for most-specific matching
private let sortedPrefixes = knownPrefixes.sorted { $0.count > $1.count }

private func detectPrefix(_ value: String) -> String {
    for p in sortedPrefixes {
        if value.hasPrefix(p) { return p }
    }
    return ""
}

// MARK: - HMAC-SHA256

private func hmacSHA256(key: String, message: String) -> [UInt8] {
    let keyData = Array(key.utf8)
    let messageData = Array(message.utf8)
    var result = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    CCHmac(
        CCHmacAlgorithm(kCCHmacAlgSHA256),
        keyData, keyData.count,
        messageData, messageData.count,
        &result
    )
    return result
}

private func toHex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

// MARK: - Public API

/// Produce a deterministic, format-preserving masked value.
///
/// `masked = prefix + hex(HMAC-SHA256(sessionId+secretName, realValue))`
/// truncated or repeated to match the original value length.
public func mask(sessionId: String, secretName: String, realValue: String) -> String {
    let prefix = detectPrefix(realValue)
    let remainder = String(realValue.dropFirst(prefix.count))

    let hmac = hmacSHA256(key: sessionId + secretName, message: realValue)
    var hex = toHex(hmac)

    // Repeat hex if remainder is longer than 64 hex chars
    while hex.count < remainder.count { hex += hex }
    let maskedRemainder = String(hex.prefix(remainder.count))

    return prefix + maskedRemainder
}

/// A pair of real ↔ masked secret values for scrubbing.
public struct SecretPair {
    public let realValue: String
    public let maskedValue: String

    public init(realValue: String, maskedValue: String) {
        self.realValue = realValue
        self.maskedValue = maskedValue
    }
}

/// Build a reusable scrubber that replaces every occurrence of any
/// `realValue` with its `maskedValue`.
///
/// Secrets are sorted longest-first to avoid partial-match clobbering.
public func buildScrubber(secrets: [SecretPair]) -> (String) -> String {
    guard !secrets.isEmpty else { return { $0 } }

    let sorted = secrets.sorted { $0.realValue.count > $1.realValue.count }

    return { text in
        var result = text
        for pair in sorted {
            result = result.replacingOccurrences(of: pair.realValue, with: pair.maskedValue)
        }
        return result
    }
}

/// Domain glob matching.
///
/// - `api.github.com` matches exactly
/// - `*.github.com` matches `api.github.com`, `uploads.github.com`,
///   but NOT `github.com` itself
public func domainMatches(pattern: String, hostname: String) -> Bool {
    let p = pattern.lowercased()
    let h = hostname.lowercased()

    guard p.hasPrefix("*.") else {
        return p == h
    }

    // Wildcard: `*.example.com`
    let suffix = String(p.dropFirst(1)) // `.example.com`
    return h.count > suffix.count && h.hasSuffix(suffix)
}

/// Check if hostname is allowed by any of the domain patterns.
public func isAllowedDomain(patterns: [String], hostname: String) -> Bool {
    patterns.contains { domainMatches(pattern: $0, hostname: hostname) }
}

