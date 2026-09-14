import Foundation

actor AgentActivityTracker {
    static let activityWindow: TimeInterval = 60

    private let now: @Sendable () -> Date
    private var lastActivityAt: Date?

    init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    func recordActivity() {
        self.lastActivityAt = self.now()
    }

    func isActiveInLastMinute() -> Bool {
        guard let lastActivityAt = self.lastActivityAt else { return false }
        return self.now().timeIntervalSince(lastActivityAt) <= Self.activityWindow
    }
}
