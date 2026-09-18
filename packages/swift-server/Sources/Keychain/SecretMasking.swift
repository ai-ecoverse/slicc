import CommonCrypto
import Foundation



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


private let sortedPrefixes = knownPrefixes.sorted { $0.count > $1.count }

private func detectPrefix(_ value: String) -> String {
    for p in sortedPrefixes {
        if value.hasPrefix(p) { return p }
    }
    return ""
}



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






public func hmacSHA256Hex(key: String, message: [UInt8]) -> String {
    let keyData = Array(key.utf8)
    var result = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    CCHmac(
        CCHmacAlgorithm(kCCHmacAlgSHA256),
        keyData, keyData.count,
        message, message.count,
        &result
    )
    return toHex(result)
}














public func mask(sessionId: String, secretName: String, realValue: String) -> String {
    let prefix = detectPrefix(realValue)
    
    
    
    
    let prefixUTF16Length = prefix.utf16.count
    let remainderUTF16Length = realValue.utf16.count - prefixUTF16Length

    let hmac = hmacSHA256(key: sessionId + secretName, message: realValue)
    var hex = toHex(hmac)

    
    while hex.count < remainderUTF16Length { hex += hex }
    let maskedRemainder = String(hex.prefix(remainderUTF16Length))

    return prefix + maskedRemainder
}


public struct SecretPair {
    public let realValue: String
    public let maskedValue: String

    public init(realValue: String, maskedValue: String) {
        self.realValue = realValue
        self.maskedValue = maskedValue
    }
}









public let minMaskableSecretLength: Int = 9










public func buildScrubber(secrets: [SecretPair]) -> @Sendable (String) -> String {
    let eligible = secrets.filter { $0.realValue.utf16.count >= minMaskableSecretLength }
    guard !eligible.isEmpty else { return { $0 } }

    let sorted = eligible.sorted { $0.realValue.count > $1.realValue.count }

    return { text in
        var result = text
        for pair in sorted {
            result = result.replacingOccurrences(of: pair.realValue, with: pair.maskedValue)
        }
        return result
    }
}







public func domainMatches(pattern: String, hostname: String) -> Bool {
    let p = pattern.lowercased()
    let h = hostname.lowercased()

    
    if p == "*" { return true }

    guard p.hasPrefix("*.") else {
        return p == h
    }

    
    let suffix = String(p.dropFirst(1))  
    return h.count > suffix.count && h.hasSuffix(suffix)
}


public func isAllowedDomain(patterns: [String], hostname: String) -> Bool {
    patterns.contains { domainMatches(pattern: $0, hostname: hostname) }
}
