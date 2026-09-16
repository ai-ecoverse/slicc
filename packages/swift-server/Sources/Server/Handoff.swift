import Foundation

private let handoffTimestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

enum Handoff {

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
