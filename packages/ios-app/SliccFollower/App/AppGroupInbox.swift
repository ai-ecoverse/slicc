import Foundation

/// Bounded handoff queue in the App Group container (#1918): the Share
/// extension cannot foreground the app, so it parks validated requests
/// here and the app drains them on scene-activation into confirmation
/// cards. Foundation-only — this file compiles into both the app and the
/// extension targets.
///
/// One-time IDs: a drained request is removed before it is surfaced, so a
/// crash between drain and confirmation drops the request rather than
/// replaying it — fail-closed, per the issue.
struct AppGroupInbox {
    struct Request: Codable, Equatable {
        let id: UUID
        let url: URL
        let receivedAt: Date
    }

    static let suiteName = "group.ai.sliccy.follower"
    static let key = "inbound-share-requests"
    /// A share sheet enqueues one URL at a time; anything beyond a small
    /// backlog is a stuck queue, not intent.
    static let maxPending = 5

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = UserDefaults(suiteName: AppGroupInbox.suiteName)) {
        self.defaults = defaults
    }

    /// Append a request; drops silently when the queue is full or the App
    /// Group is unavailable (unprovisioned dev builds degrade like iCloud).
    @discardableResult
    func enqueue(url: URL, now: Date = Date()) -> Bool {
        guard let defaults else { return false }
        var pending = load()
        guard pending.count < Self.maxPending else { return false }
        pending.append(Request(id: UUID(), url: url, receivedAt: now))
        guard let data = try? JSONEncoder().encode(pending) else { return false }
        defaults.set(data, forKey: Self.key)
        return true
    }

    /// Remove and return everything pending.
    func drain() -> [Request] {
        guard let defaults else { return [] }
        let pending = load()
        defaults.removeObject(forKey: Self.key)
        return pending
    }

    private func load() -> [Request] {
        guard let data = defaults?.data(forKey: Self.key),
            let pending = try? JSONDecoder().decode([Request].self, from: data)
        else { return [] }
        return pending
    }
}
