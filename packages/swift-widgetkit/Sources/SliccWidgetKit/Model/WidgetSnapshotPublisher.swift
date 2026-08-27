import Foundation
import WidgetKit
import os

/// Writes the home-screen widget's snapshot, at a rate WidgetKit can live
/// with.
///
/// Shared by both capture sides — the iOS follower draining `scoops.list` and
/// Sliccstart's own tray observer — because the rate-limiting rule is a
/// property of WidgetKit, not of either app.
///
/// `scoops.list` arrives on every turn boundary and every tool bracket, and a
/// reload per arrival is how a widget spends its daily refresh budget by
/// mid-morning and then sits frozen at the moment that mattered. So writes are
/// coalesced: one immediately, then at most one per ``minimumInterval``, with
/// a trailing write so the last state in a burst is never the one that gets
/// dropped.
///
/// Transitions that a person would want to see NOW — a scoop breaking, a turn
/// handing back, the link dying — bypass the rate limit via `force`. Those are
/// rare by nature, which is exactly why they can afford to.
@MainActor
public final class WidgetSnapshotPublisher {
    private let store: WidgetSnapshotStore
    private let reload: @MainActor () -> Void
    private let clock: () -> Date
    private let minimumInterval: TimeInterval
    private let logger = Logger(subsystem: "ai.sliccy.widgetkit", category: "snapshot")

    private var lastWrite: Date?
    private var pending: WidgetSnapshot?
    private var trailingTask: Task<Void, Never>?

    public init(
        store: WidgetSnapshotStore,
        minimumInterval: TimeInterval = 15,
        clock: @escaping () -> Date = { Date() },
        reload: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() }
    ) {
        self.store = store
        self.minimumInterval = minimumInterval
        self.clock = clock
        self.reload = reload
    }

    /// Whether a snapshot differs from the last one in a way a person would
    /// want off-cycle: something broke, something handed the turn back, the
    /// unit list changed shape, or the link did.
    public static func isUrgent(_ next: WidgetSnapshot, comparedTo previous: WidgetSnapshot?) -> Bool {
        guard let previous else { return true }
        if next.connection != previous.connection { return true }
        if next.brokenCount != previous.brokenCount { return true }
        if next.units.count != previous.units.count { return true }
        let awaiting = { (snapshot: WidgetSnapshot) in
            snapshot.units.filter { $0.activity == .awaiting }.count
        }
        return awaiting(next) != awaiting(previous)
    }

    /// Publish, unless the rate limit says to wait — in which case the
    /// snapshot is held and written when the window opens.
    public func publish(_ snapshot: WidgetSnapshot) {
        let urgent = Self.isUrgent(snapshot, comparedTo: lastPublished)
        let now = clock()
        if urgent || lastWrite.map({ now.timeIntervalSince($0) >= minimumInterval }) ?? true {
            write(snapshot, at: now)
            return
        }
        pending = snapshot
        scheduleTrailingWrite(after: minimumInterval - now.timeIntervalSince(lastWrite ?? now))
    }

    /// Drop the snapshot entirely. Called when the user detaches from an
    /// instance: a widget must not keep naming a session that is no longer
    /// theirs, and an empty state is the honest answer.
    public func clear() {
        trailingTask?.cancel()
        trailingTask = nil
        pending = nil
        lastPublished = nil
        lastWrite = nil
        store.clear()
        reload()
    }

    public private(set) var lastPublished: WidgetSnapshot?

    private func write(_ snapshot: WidgetSnapshot, at date: Date) {
        trailingTask?.cancel()
        trailingTask = nil
        pending = nil
        do {
            try store.write(snapshot)
            lastPublished = snapshot
            lastWrite = date
            reload()
        } catch {
            // Non-fatal, but NOT invisible. A write that fails silently is a
            // widget that never updates and a bug with no thread to pull: the
            // tile just keeps showing whatever it last had. `.error` so it
            // survives into the persisted log on a real device, where a
            // `.debug` line is dropped before anyone can read it.
            let group = store.appGroup
            let reason = String(describing: error)
            logger.error(
                "Widget snapshot not written to \(group, privacy: .public) — \(reason, privacy: .public)")
        }
    }

    private func scheduleTrailingWrite(after delay: TimeInterval) {
        guard trailingTask == nil else { return }
        let seconds = max(0, delay)
        trailingTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self, let snapshot = pending else { return }
            trailingTask = nil
            write(snapshot, at: clock())
        }
    }

    /// Test hook: run the trailing write without waiting out the interval.
    public func _testing_flushPending() {
        guard let snapshot = pending else { return }
        write(snapshot, at: clock())
    }
}
