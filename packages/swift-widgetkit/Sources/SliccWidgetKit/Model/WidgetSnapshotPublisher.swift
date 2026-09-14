import Foundation
import WidgetKit
import os


















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

    
    public func _testing_flushPending() {
        guard let snapshot = pending else { return }
        write(snapshot, at: clock())
    }
}
