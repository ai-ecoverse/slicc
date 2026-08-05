import Foundation

/// Metadata-only diagnostics for untrusted leader frames. A discriminator is
/// emitted only when it is a short ASCII protocol token; payload bytes,
/// decoding errors, URLs, and query values never enter the log string.
enum SafeLeaderMessageLog {
    static func decodeFailureSummary(_ data: Data) -> String {
        let discriminator: String
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String,
            type.count <= 64,
            !type.isEmpty,
            type.unicodeScalars.allSatisfy(isProtocolTokenScalar)
        {
            discriminator = type
        } else {
            discriminator = "unknown"
        }
        return "Failed to decode leader message (\(data.count) bytes, type=\(discriminator))"
    }

    static func urlEventSummary(_ event: String, url: String) -> String {
        "\(event) (\(url.utf8.count) URL bytes)"
    }

    private static func isProtocolTokenScalar(_ scalar: Unicode.Scalar) -> Bool {
        scalar.isASCII
            && (CharacterSet.alphanumerics.contains(scalar)
                || CharacterSet(charactersIn: "._-").contains(scalar))
    }
}
