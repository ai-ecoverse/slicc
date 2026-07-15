import Foundation

private let handoffTimestampFormatter = ISO8601DateFormatter()

/// Pure logic for `POST /api/handoff` — profile-independent handoff injection.
///
/// **Mirrors `packages/node-server/src/routes/handoff.ts`**
/// (`validateHandoffPayload` + `buildNavigateEvent`). The CDP
/// navigation-watcher only sees tabs inside the Chrome instance SLICC
/// launched, so external tools (e.g. the slicc-handoff helper) post the
/// structured payload here and the server rebroadcasts it as a
/// `navigate_event` over the lick WebSocket. The payload mirrors the parsed
/// RFC 8288 `Link` form used by the observers: `verb` ∈ {handoff, upskill},
/// `target` is the resolved URL, `instruction` is optional free-form prose
/// (handoff verb).
enum Handoff {

    /// Validate an inbound handoff payload. Returns an error message when the
    /// payload is malformed, or `nil` when it is well-formed and ready to be
    /// turned into a navigate event. Error strings match node-server
    /// byte-for-byte. Pure — no I/O.
    static func validatePayload(_ payload: LickSystem.JSONObject) -> String? {
        if payload["sliccHeader"]?.stringValue != nil {
            return "The legacy `sliccHeader` payload was removed; post `{ verb, target, instruction? }` instead. See docs/slicc-handoff.md."
        }
        let verb = payload["verb"]?.stringValue
        if verb != "handoff" && verb != "upskill" {
            return "verb must be \"handoff\" or \"upskill\""
        }
        guard let target = payload["target"]?.stringValue, !target.isEmpty else {
            return "target is required (non-empty string)"
        }
        if isProvidedNonString(payload["instruction"]) {
            return "instruction must be a string when provided"
        }
        // `branch` / `path` mirror the upskill rel's Link params and are
        // ignored on the handoff verb (its target is the page itself, not a
        // repo). Reject the wrong-shape combo loudly so emitters notice
        // rather than silently dropping the scope.
        if isProvidedNonString(payload["branch"]) {
            return "branch must be a string when provided"
        }
        if isProvidedNonString(payload["path"]) {
            return "path must be a string when provided"
        }
        if verb == "handoff", isProvided(payload["branch"]) || isProvided(payload["path"]) {
            return "branch and path are only valid with verb=\"upskill\""
        }
        return nil
    }

    /// Build the navigate event broadcast to the browser. Assumes a valid payload.
    static func buildNavigateEvent(_ payload: LickSystem.JSONObject) -> LickSystem.JSONObject {
        var event: LickSystem.JSONObject = [
            "type": .string("navigate_event"),
            "verb": .string(payload["verb"]?.stringValue ?? ""),
            "target": .string(payload["target"]?.stringValue ?? ""),
            "url": .string(nonEmptyString(payload["url"]) ?? "about:handoff"),
            "timestamp": .string(handoffTimestampFormatter.string(from: Date())),
        ]
        if let instruction = payload["instruction"]?.stringValue {
            event["instruction"] = .string(instruction)
        }
        if let title = payload["title"]?.stringValue {
            event["title"] = .string(title)
        }
        if let branch = nonEmptyString(payload["branch"]) {
            event["branch"] = .string(branch)
        }
        if let path = nonEmptyString(payload["path"]) {
            event["path"] = .string(path)
        }
        return event
    }

    /// JSON `null` counts as absent, mirroring the TS `!= null` guards.
    private static func isProvided(_ value: LickSystem.JSONValue?) -> Bool {
        guard let value else { return false }
        return value != .null
    }

    private static func isProvidedNonString(_ value: LickSystem.JSONValue?) -> Bool {
        self.isProvided(value) && value?.stringValue == nil
    }

    private static func nonEmptyString(_ value: LickSystem.JSONValue?) -> String? {
        guard let string = value?.stringValue, !string.isEmpty else { return nil }
        return string
    }
}
