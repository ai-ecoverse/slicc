import Foundation

/// The pieces an exhausted-provider-budget failure is rendered from.
///
/// Swift mirror of `parseQuotaExceededError` in
/// `packages/webapp/src/core/error-families.ts`. The leader's error card shows
/// the provider's own prose under an "Out of AI budget" header; without this
/// the follower would keep printing the raw
/// `429 {"error":{"type":"quota_exceeded",…}}` envelope under a generic
/// "Something went wrong", which is the same failure told twice as badly.
///
/// Only the TEXT is mirrored. The leader's card also offers "Switch provider
/// and try again" / "Add a provider"; the follower renders no CTA at all
/// (see `ErrorCard`), because both act on leader-side state the
/// follower→leader protocol carries no message for.
struct QuotaExceededDetail: Equatable {
    /// The provider's explanation, with the trailing "connect your own LLM
    /// provider" sentence dropped — on the follower there is nothing to click.
    let message: String
    /// ISO-8601 instant the budget refills, when the provider sent one.
    let resetsAt: String?

    /// Header the error card shows instead of "Something went wrong".
    static let label = "Out of AI budget"

    /// Body for an envelope that carried no usable message of its own.
    static let fallbackMessage = "The usage budget for this provider has been fully used."

    /// The `error.type` the Adobe proxy stamps on an exhausted-budget refusal.
    /// Matched instead of the prose, so re-worded proxy copy — or a
    /// `Scoop "…" failed with unrecoverable error: ` wrapper — never drops the
    /// failure out of detection.
    private static let typeToken = "quota_exceeded"

    /// Trailing self-service sentence the leader's CTAs replace.
    private static let connectCtaPattern = #"\s*You can (also )?connect your own LLM provider\.?\s*$"#

    /// Parse `content` as a quota refusal, or `nil` if it is not one. A
    /// malformed or truncated envelope still yields a detail: the family is
    /// established by the type token, and a parse miss must not fall back to
    /// dumping JSON at the reader.
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

    /// The `error` object inside the JSON the provider status line prefixes
    /// (`429 {…}`). Widest span from the first `{` to the last `}`, so a
    /// wrapper prefix never breaks the parse.
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

    /// Card body: the provider's prose, plus the structured reset instant when
    /// — and only when — that prose does not already name one, so the card
    /// never states the same reset twice in two formats.
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
