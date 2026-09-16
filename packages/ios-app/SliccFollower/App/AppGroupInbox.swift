import Foundation

struct AppGroupInbox {
    struct Request: Codable, Equatable {
        let id: UUID
        let url: URL
        let receivedAt: Date
    }

    static let suiteName = "group.ai.sliccy.follower"
    static let key = "inbound-share-requests"

    static let maxPending = 5

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = UserDefaults(suiteName: AppGroupInbox.suiteName)) {
        self.defaults = defaults
    }

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
