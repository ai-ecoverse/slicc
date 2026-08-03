import Foundation
import SliccTrayKit

extension LickEvent {
    /// Build the navigate lick for a recognised handoff, matching the body the
    /// browser follower's navigate watcher sends
    /// (`ui/follower-navigate-watcher.ts`).
    static func navigate(
        pageURL: String,
        match: HandoffMatch,
        title: String? = nil,
        timestamp: String = ISO8601DateFormatter().string(from: Date())
    ) -> LickEvent {
        // Raw values, not pre-wrapped: `AnyCodable` wraps nested containers
        // itself, and handing it a dictionary of `AnyCodable` double-wraps.
        var body: [String: Any] = [
            "url": pageURL,
            "verb": match.verb.rawValue,
            "target": match.target,
        ]
        if let instruction = match.instruction { body["instruction"] = instruction }
        if let branch = match.branch { body["branch"] = branch }
        if let path = match.path { body["path"] = path }
        if let title, !title.isEmpty { body["title"] = title }
        return LickEvent(
            type: .navigate,
            timestamp: timestamp,
            body: AnyCodable(body),
            navigateUrl: pageURL)
    }
}
