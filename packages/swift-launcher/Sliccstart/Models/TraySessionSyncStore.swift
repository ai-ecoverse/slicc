import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "TraySessionSyncStore")

/// Minimal key/value transport the sync store persists through. The default
/// implementation is iCloud (`NSUbiquitousKeyValueStore`); tests inject an
/// in-memory backend so no unit test touches iCloud.
protocol KeyValueSyncBackend: AnyObject {
    func data(forKey key: String) -> Data?
    func setData(_ data: Data?, forKey key: String)
    @discardableResult func synchronize() -> Bool
    /// When non-nil, the store registers a NotificationCenter observer for
    /// `name`/`object` and reloads when the backend reports an external
    /// (other-device) change. iCloud supplies this; the in-memory backend
    /// returns nil.
    var externalChange: (name: Notification.Name, object: AnyObject?)? { get }
}

/// iCloud key-value backend. Degrades gracefully to a local cache when the
/// app is not (yet) provisioned for iCloud — reads/writes still succeed,
/// they just do not sync — so the launcher never crashes on a build that
/// lacks the `com.apple.developer.ubiquity-kvstore-identifier` entitlement.
final class UbiquitousKeyValueBackend: KeyValueSyncBackend {
    private let store: NSUbiquitousKeyValueStore

    init(store: NSUbiquitousKeyValueStore = .default) {
        self.store = store
    }

    func data(forKey key: String) -> Data? {
        store.data(forKey: key)
    }

    func setData(_ data: Data?, forKey key: String) {
        if let data {
            store.set(data, forKey: key)
        } else {
            store.removeObject(forKey: key)
        }
    }

    @discardableResult
    func synchronize() -> Bool {
        store.synchronize()
    }

    var externalChange: (name: Notification.Name, object: AnyObject?)? {
        (NSUbiquitousKeyValueStore.didChangeExternallyNotification, store)
    }
}

/// In-memory backend for tests and for platforms/builds without iCloud.
final class InMemoryKeyValueBackend: KeyValueSyncBackend {
    private var storage: [String: Data] = [:]

    func data(forKey key: String) -> Data? { storage[key] }
    func setData(_ data: Data?, forKey key: String) { storage[key] = data }
    @discardableResult func synchronize() -> Bool { true }
    var externalChange: (name: Notification.Name, object: AnyObject?)? { nil }
}

/// Cross-device store of active tray join URLs, backed by iCloud key-value
/// sync. The macOS launcher publishes its leader session here so the same
/// user's other devices (and, later, the iOS follower) can discover and
/// join it without hand-copying a join URL.
///
/// `@Observable` so a SwiftUI list redraws the moment iCloud pushes an
/// external change. All persistence logic lives in the pure static helpers
/// (`active(from:)`, `upsert(_:into:)`) so it can be unit-tested without a
/// backend.
@Observable
final class TraySessionSyncStore {
    static let storageKey = "activeTraySessions.v1"
    static let defaultTTL: TimeInterval = 12 * 60 * 60
    static let maxSessions = 64

    /// Non-stale sessions, newest first. Observable.
    private(set) var sessions: [SyncedTraySession] = []

    @ObservationIgnored private let backend: KeyValueSyncBackend
    @ObservationIgnored private let ttl: TimeInterval
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored let deviceName: String
    @ObservationIgnored private var observer: NSObjectProtocol?

    init(
        backend: KeyValueSyncBackend = UbiquitousKeyValueBackend(),
        deviceName: String = TraySessionSyncStore.currentDeviceName(),
        ttl: TimeInterval = TraySessionSyncStore.defaultTTL,
        clock: @escaping () -> Date = Date.init
    ) {
        self.backend = backend
        self.deviceName = deviceName
        self.ttl = ttl
        self.clock = clock
        registerExternalObserver()
        _ = backend.synchronize()
        reload()
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Read

    /// Sessions published by other devices — the ones worth acting on here.
    var remoteSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceName != deviceName }
    }

    /// Sessions this device published (shown read-only so the user can see
    /// their own leader is being advertised).
    var localSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceName == deviceName }
    }

    func reload() {
        sessions = TraySessionSyncStore.active(from: decodeRaw(), ttl: ttl, now: clock())
    }

    // MARK: - Write

    /// Advertise (or refresh) a session originating from this device.
    func publish(joinUrl: String, label: String) {
        guard !joinUrl.isEmpty else { return }
        let now = clock()
        var raw = decodeRaw()
        let existing = raw.first { $0.id == SyncedTraySession.identifier(forJoinUrl: joinUrl) }
        let session = SyncedTraySession(
            joinUrl: joinUrl,
            label: label,
            deviceName: deviceName,
            createdAt: existing?.createdAt ?? now,
            lastSeenAt: now
        )
        raw = TraySessionSyncStore.upsert(session, into: raw)
        persist(TraySessionSyncStore.active(from: raw, ttl: ttl, now: now))
    }

    /// Remove a single session by its join URL.
    func withdraw(joinUrl: String) {
        let id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        persist(TraySessionSyncStore.active(from: decodeRaw().filter { $0.id != id }, ttl: ttl, now: clock()))
    }

    /// Remove every session this device published. Called on a clean quit
    /// so a dead leader stops being advertised to other devices.
    func withdrawLocalSessions() {
        persist(TraySessionSyncStore.active(from: decodeRaw().filter { $0.deviceName != deviceName }, ttl: ttl, now: clock()))
    }

    // MARK: - Pure helpers (unit-testable without a backend)

    static func upsert(_ session: SyncedTraySession, into list: [SyncedTraySession]) -> [SyncedTraySession] {
        var next = list.filter { $0.id != session.id }
        next.append(session)
        return next
    }

    static func active(from raw: [SyncedTraySession], ttl: TimeInterval, now: Date) -> [SyncedTraySession] {
        raw
            .filter { !$0.isStale(ttl: ttl, now: now) }
            .sorted { $0.lastSeenAt > $1.lastSeenAt }
            .prefix(maxSessions)
            .map { $0 }
    }

    static func currentDeviceName() -> String {
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "This device" : name
    }

    // MARK: - Backend plumbing

    private func decodeRaw() -> [SyncedTraySession] {
        guard let data = backend.data(forKey: Self.storageKey) else { return [] }
        do {
            return try JSONDecoder().decode([SyncedTraySession].self, from: data)
        } catch {
            log.error("decodeRaw: failed to decode payload: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private func persist(_ list: [SyncedTraySession]) {
        do {
            let data = try JSONEncoder().encode(list)
            backend.setData(data, forKey: Self.storageKey)
            _ = backend.synchronize()
        } catch {
            log.error("persist: failed to encode payload: \(error.localizedDescription, privacy: .public)")
        }
        sessions = TraySessionSyncStore.active(from: list, ttl: ttl, now: clock())
    }

    private func registerExternalObserver() {
        guard let external = backend.externalChange else { return }
        observer = NotificationCenter.default.addObserver(
            forName: external.name,
            object: external.object,
            queue: .main
        ) { [weak self] _ in
            self?.reload()
        }
    }
}
