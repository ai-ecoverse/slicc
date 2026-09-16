import Foundation
import Observation
import os

private let log = Logger(subsystem: "ai.sliccy.traysession", category: "TraySessionSyncStore")

public protocol KeyValueSyncBackend: AnyObject {
    func data(forKey key: String) -> Data?
    func setData(_ data: Data?, forKey key: String)

    func keys(withPrefix prefix: String) -> [String]
    @discardableResult func synchronize() -> Bool

    var externalChange: (name: Notification.Name, object: AnyObject?)? { get }
}

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

@Observable
public final class TraySessionSyncStore {

    public static let storageKeyPrefix = "traySessions.v2."
    public static let deviceIdDefaultsKey = "traySyncDeviceId"
    public static let defaultTTL: TimeInterval = 12 * 60 * 60
    public static let maxSessions = 64

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

    public var remoteSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceId != deviceId }
    }

    public var localSessions: [SyncedTraySession] {
        sessions.filter { $0.deviceId == deviceId }
    }

    public func reload() {
        sessions = TraySessionSyncStore.active(from: decodeAll(), ttl: ttl, now: clock())
    }

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

    public func withdraw(joinUrl: String) {
        let id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        persistOwn(TraySessionSyncStore.active(from: decodeOwn().filter { $0.id != id }, ttl: ttl, now: clock()))
    }

    public func withdrawLocalSessions() {
        backend.setData(nil, forKey: ownKey)
        _ = backend.synchronize()
        reload()
    }

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

            let name = Host.current().localizedName ?? ""
            return name.isEmpty ? "This device" : name
        #else
            return "This device"
        #endif
    }

    public static func currentDeviceId(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: deviceIdDefaultsKey), !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString
        defaults.set(fresh, forKey: deviceIdDefaultsKey)
        return fresh
    }

    private func decodeOwn() -> [SyncedTraySession] {
        decode(key: ownKey)
    }

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
