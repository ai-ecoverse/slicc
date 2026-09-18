import Foundation

/// Provider-neutral pieces an exhausted AI budget is rendered from.
///
/// Swift mirror of `parseExhaustedBudgetError` in
/// `packages/webapp/src/core/error-families.ts`. The leader's error card shows
/// provider-appropriate prose under an "Out of AI budget" header. Adobe sends
/// a structured 429 with reset metadata; Grok sends a text 403 about credits
/// or subscription. Both must read as the same family on the follower.
///
/// Only the TEXT is mirrored. The leader's card also offers "Switch provider
/// and try again" / "Add a provider"; the follower renders no CTA at all
/// (see `ErrorCard`), because both act on leader-side state the
/// follower→leader protocol carries no message for.
struct ExhaustedBudgetDetail: Equatable {
    /// Provider-appropriate explanation, with the trailing "connect your own
    /// LLM provider" sentence dropped — there is nothing to click here.
    let message: String
    /// ISO-8601 instant the budget refills, when the provider sent one.
    let resetsAt: String?

    /// Header the error card shows instead of "Something went wrong".
    static let label = "Out of AI budget"

    /// Body for an envelope that carried no usable message of its own.
    static let fallbackMessage = "The usage budget for this provider has been fully used."

    /// The `error.type` the Adobe proxy stamps on an exhausted-budget refusal.
    private static let adobeTypeToken = "quota_exceeded"

    /// Stable halves of Grok's 403 credit/subscription refusal. Subscription
    /// markers keep the "Grok" token so a third provider's generic credits +
    /// subscription prose cannot inherit Grok-branded copy.
    private static let grokResourceMarkers = [
        "run out of available resources", "ran out of available resources",
        "run out of credits", "ran out of credits",
    ]
    private static let grokSubscriptionMarkers = [
        "active grok subscription", "need a grok subscription",
        "needs a grok subscription",
    ]
    private static let grokMessage =
        "Your Grok account has run out of credits or does not have an active subscription."

    /// Trailing self-service sentence the leader's CTAs replace.
    private static let connectCtaPattern = #"\s*You can (also )?connect your own LLM provider\.?\s*$"#

    /// Parse `content` as an exhausted-budget refusal, or `nil` if it is not
    /// one. Substring matching survives a scoop unrecoverable-error wrapper.
    /// A malformed Adobe envelope still yields a detail rather than raw JSON.
    init?(content: String) {
        let lower = content.lowercased()
        let isAdobe = lower.contains(Self.adobeTypeToken)
        let isGrok =
            Self.grokResourceMarkers.contains(where: lower.contains)
            && Self.grokSubscriptionMarkers.contains(where: lower.contains)
        guard isAdobe || isGrok else { return nil }
        guard isAdobe else {
            message = Self.grokMessage
            resetsAt = nil
            return
        }
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
