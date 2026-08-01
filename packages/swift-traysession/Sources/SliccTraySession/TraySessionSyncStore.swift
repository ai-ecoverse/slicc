import Foundation
import Observation
import os

private let log = Logger(subsystem: "ai.sliccy.traysession", category: "TraySessionSyncStore")

/// Minimal key/value transport the sync store persists through. The default
/// implementation is iCloud (`NSUbiquitousKeyValueStore`); tests inject an
/// in-memory backend so no unit test touches iCloud.
public protocol KeyValueSyncBackend: AnyObject {
    func data(forKey key: String) -> Data?
    func setData(_ data: Data?, forKey key: String)
    /// Every currently-stored key beginning with `prefix`. Used to merge each
    /// device's own per-device session key into the combined view.
    func keys(withPrefix prefix: String) -> [String]
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
public final class UbiquitousKeyValueBackend: KeyValueSyncBackend {
    private let store: NSUbiquitousKeyValueStore

    public init(store: NSUbiquitousKeyValueStore = .default) {
        self.store = store
    }

    public func data(forKey key: String) -> Data? {
        store.data(forKey: key)
    }

    public func setData(_ data: Data?, forKey key: String) {
        if let data {
            store.set(data, forKey: key)
        } else {
            store.removeObject(forKey: key)
        }
    }

    public func keys(withPrefix prefix: String) -> [String] {
        store.dictionaryRepresentation.keys.filter { $0.hasPrefix(prefix) }
    }

    @discardableResult
    public func synchronize() -> Bool {
        store.synchronize()
    }

    public var externalChange: (name: Notification.Name, object: AnyObject?)? {
        (NSUbiquitousKeyValueStore.didChangeExternallyNotification, store)
    }
}

/// In-memory backend for tests and for platforms/builds without iCloud.
public final class InMemoryKeyValueBackend: KeyValueSyncBackend {
    public init() {}

    private var storage: [String: Data] = [:]

    public func data(forKey key: String) -> Data? { storage[key] }
    public func setData(_ data: Data?, forKey key: String) { storage[key] = data }
    public func keys(withPrefix prefix: String) -> [String] {
        storage.keys.filter { $0.hasPrefix(prefix) }
    }
    @discardableResult public func synchronize() -> Bool { true }
    public var externalChange: (name: Notification.Name, object: AnyObject?)? { nil }
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
public final class TraySessionSyncStore {
    /// Each device writes its own sessions under `storageKeyPrefix + deviceId`
    /// and reads the union of every such key. Per-device keys mean two devices
    /// publishing at once never overwrite each other's advertisement (each
    /// only ever writes its own key), which a single shared array could not
    /// guarantee.
    public static let storageKeyPrefix = "traySessions.v2."
    public static let deviceIdDefaultsKey = "traySyncDeviceId"
    public static let defaultTTL: TimeInterval = 12 * 60 * 60
    public static let maxSessions = 64

    /// Non-stale sessions, newest first. Observable.
    public private(set) var sessions: [SyncedTraySession] = []

    @ObservationIgnored private let backend: KeyValueSyncBackend
    @ObservationIgnored private let ttl: TimeInterval
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored public let deviceId: String
    @ObservationIgnored public let deviceName: String
    @ObservationIgnored private var observer: NSObjectProtocol?

    private var ownKey: String { Self.storageKeyPrefix + deviceId }

    public init(
        backend: KeyValueSyncBackend = UbiquitousKeyValueBackend(),
        deviceId: String = TraySessionSyncStore.currentDeviceId(),
        deviceName: String = TraySessionSyncStore.currentDeviceName(),
        ttl: TimeInterval = TraySessionSyncStore.defaultTTL,
        clock: @escaping () -> Date = Date.init
    ) {
        self.backend = backend
        self.deviceId = deviceId
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
    public var remoteSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceId != deviceId }
    }

    /// Sessions this device published (shown read-only so the user can see
    /// their own leader is being advertised).
    public var localSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceId == deviceId }
    }

    public func reload() {
        sessions = TraySessionSyncStore.active(from: decodeAll(), ttl: ttl, now: clock())
    }

    // MARK: - Write

    /// Advertise (or refresh) a session originating from this device. Only
    /// ever writes this device's own key, so a concurrent publish on another
    /// device cannot clobber it.
    public func publish(joinUrl: String, label: String) {
        guard !joinUrl.isEmpty else { return }
        let now = clock()
        var own = decodeOwn()
        let existing = own.first { $0.id == SyncedTraySession.identifier(forJoinUrl: joinUrl) }
        let session = SyncedTraySession(
            joinUrl: joinUrl,
            label: label,
            deviceId: deviceId,
            deviceName: deviceName,
            createdAt: existing?.createdAt ?? now,
            lastSeenAt: now
        )
        own = TraySessionSyncStore.upsert(session, into: own)
        persistOwn(TraySessionSyncStore.active(from: own, ttl: ttl, now: now))
    }

    /// Remove a single session by its join URL (from this device's own key).
    public func withdraw(joinUrl: String) {
        let id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        persistOwn(TraySessionSyncStore.active(from: decodeOwn().filter { $0.id != id }, ttl: ttl, now: clock()))
    }

    /// Remove every session this device published by clearing its own key.
    /// Called on a clean quit so a dead leader stops being advertised. Never
    /// touches another device's key, even if two devices share a host name.
    public func withdrawLocalSessions() {
        backend.setData(nil, forKey: ownKey)
        _ = backend.synchronize()
        reload()
    }

    // MARK: - Pure helpers (unit-testable without a backend)

    public static func upsert(_ session: SyncedTraySession, into list: [SyncedTraySession]) -> [SyncedTraySession] {
        var next = list.filter { $0.id != session.id }
        next.append(session)
        return next
    }

    public static func active(from raw: [SyncedTraySession], ttl: TimeInterval, now: Date) -> [SyncedTraySession] {
        raw
            .filter { !$0.isStale(ttl: ttl, now: now) }
            .sorted { $0.lastSeenAt > $1.lastSeenAt }
            .prefix(maxSessions)
            .map { $0 }
    }

    public static func currentDeviceName() -> String {
        #if os(macOS)
            // `Host` (NSHost) is macOS-only Foundation. iOS callers pass their
            // own `deviceName:` at init (UIDevice lives above this package).
            let name = Host.current().localizedName ?? ""
            return name.isEmpty ? "This device" : name
        #else
            return "This device"
        #endif
    }

    /// A stable per-device UUID persisted in `UserDefaults`, minted once.
    /// Used as the ownership key so two devices with the same host name stay
    /// distinct.
    public static func currentDeviceId(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: deviceIdDefaultsKey), !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString
        defaults.set(fresh, forKey: deviceIdDefaultsKey)
        return fresh
    }

    // MARK: - Backend plumbing

    /// This device's own advertised sessions.
    private func decodeOwn() -> [SyncedTraySession] {
        decode(key: ownKey)
    }

    /// The union of every device's advertised sessions.
    private func decodeAll() -> [SyncedTraySession] {
        backend.keys(withPrefix: Self.storageKeyPrefix).flatMap { decode(key: $0) }
    }

    private func decode(key: String) -> [SyncedTraySession] {
        guard let data = backend.data(forKey: key) else { return [] }
        do {
            return try JSONDecoder().decode([SyncedTraySession].self, from: data)
        } catch {
            log.error("decode: failed to decode payload: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private func persistOwn(_ list: [SyncedTraySession]) {
        do {
            let data = try JSONEncoder().encode(list)
            backend.setData(data, forKey: ownKey)
            _ = backend.synchronize()
        } catch {
            log.error("persistOwn: failed to encode payload: \(error.localizedDescription, privacy: .public)")
        }
        reload()
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
