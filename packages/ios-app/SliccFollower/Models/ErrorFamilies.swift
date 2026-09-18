import Foundation














struct QuotaExceededDetail: Equatable {
    
    
    let message: String
    
    let resetsAt: String?

    
    static let label = "Out of AI budget"

    
    static let fallbackMessage = "The usage budget for this provider has been fully used."

    
    
    
    
    private static let typeToken = "quota_exceeded"

    
    private static let connectCtaPattern = #"\s*You can (also )?connect your own LLM provider\.?\s*$"#

    
    
    
    
    init?(content: String) {
        guard content.lowercased().contains(Self.typeToken) else { return nil }
        let error = Self.errorEnvelope(in: content)
        let raw = error?["message"] as? String ?? ""
        let stripped = raw.replacingOccurrences(
            of: Self.connectCtaPattern,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        message = stripped.isEmpty ? Self.fallbackMessage : stripped
        if let resets = error?["resets_at"] as? String, !resets.isEmpty {
            resetsAt = resets
        } else {
            resetsAt = nil
        }
    }

    
    
    
    private static func errorEnvelope(in content: String) -> [String: Any]? {
        guard let start = content.firstIndex(of: "{"), let end = content.lastIndex(of: "}"),
            start < end
        else { return nil }
        let json = String(content[start...end])
        guard let data = json.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["error"] as? [String: Any]
    }

    
    
    
    var body: String {
        guard let resetsAt, message.range(of: "reset", options: .caseInsensitive) == nil else {
            return message
        }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: resetsAt) ?? ISO8601DateFormatter().date(from: resetsAt)
        guard let date else { return message }
        let out = DateFormatter()
        out.dateStyle = .long
        out.timeStyle = .none
        return "\(message) Resets on \(out.string(from: date))."
    }
}
