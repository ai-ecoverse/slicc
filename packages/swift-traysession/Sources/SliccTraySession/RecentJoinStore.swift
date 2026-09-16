import Foundation
import Observation
import os

private let recentsLog = Logger(subsystem: "ai.sliccy.traysession", category: "RecentJoinStore")

public struct RecentJoin: Codable, Equatable, Identifiable {

    public let id: String

    public var joinUrl: String

    public var label: String

    public var deviceId: String

    public var deviceName: String
    public var firstConnectedAt: Date
    public var lastConnectedAt: Date

    public init(
        joinUrl: String,
        label: String,
        deviceId: String,
        deviceName: String,
        firstConnectedAt: Date,
        lastConnectedAt: Date
    ) {
        self.id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        self.joinUrl = joinUrl
        self.label = label
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.firstConnectedAt = firstConnectedAt
        self.lastConnectedAt = lastConnectedAt
    }

    public var displayHost: String {
        guard let components = URLComponents(string: joinUrl), let host = components.host else {
            return ""
        }
        guard let port = components.port else { return host }
        return "\(host):\(port)"
    }

    public func isStale(ttl: TimeInterval, now: Date) -> Bool {
        now.timeIntervalSince(lastConnectedAt) > ttl
    }
}

@Observable
public final class RecentJoinStore {
    public static let storageKeyPrefix = "recentJoins.v1."

    public static let defaultTTL: TimeInterval = 30 * 24 * 60 * 60

    public static let maxRecents = 5

    public static let maxPooled = 20

    public private(set) var recents: [RecentJoin] = []

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
        ttl: TimeInterval = RecentJoinStore.defaultTTL,
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

    public func reload() {
        recents = Self.active(from: decodeAll(), ttl: ttl, now: clock())
    }

    public static func rank(
        _ list: [RecentJoin],
        limit: Int = RecentJoinStore.maxRecents,
        isReachable: (String) -> Bool
    ) -> [RecentJoin] {
        let ordered = list.sorted { lhs, rhs in
            let lhsReachable = isReachable(lhs.id)
            let rhsReachable = isReachable(rhs.id)
            if lhsReachable != rhsReachable { return lhsReachable }
            if lhs.lastConnectedAt != rhs.lastConnectedAt {
                return lhs.lastConnectedAt > rhs.lastConnectedAt
            }

            return lhs.id < rhs.id
        }
        return Array(ordered.prefix(max(0, limit)))
    }

    public func ranked(
        limit: Int = RecentJoinStore.maxRecents,
        isReachable: (String) -> Bool
    ) -> [RecentJoin] {
        Self.rank(recents, limit: limit, isReachable: isReachable)
    }

    public func record(joinUrl: String, label: String) {
        let trimmed = joinUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let now = clock()
        var own = decodeOwn()
        let existing = own.first { $0.id == SyncedTraySession.identifier(forJoinUrl: trimmed) }
        let entry = RecentJoin(
            joinUrl: trimmed,

            label: label.isEmpty ? (existing?.label ?? "") : label,
            deviceId: deviceId,
            deviceName: deviceName,
            firstConnectedAt: existing?.firstConnectedAt ?? now,
            lastConnectedAt: now
        )
        own.removeAll { $0.id == entry.id }
        own.append(entry)
        persistOwn(Array(Self.active(from: own, ttl: ttl, now: now).prefix(Self.maxRecents)))
    }

    public func forget(id: String) {
        persistOwn(Self.active(from: decodeOwn().filter { $0.id != id }, ttl: ttl, now: clock()))
    }

    public func clearLocalHistory() {
        backend.setData(nil, forKey: ownKey)
        _ = backend.synchronize()
        reload()
    }

    public static func active(from raw: [RecentJoin], ttl: TimeInterval, now: Date) -> [RecentJoin] {
        let merged = merge(raw.filter { !$0.isStale(ttl: ttl, now: now) })
        return Array(
            merged
                .sorted { lhs, rhs in
                    if lhs.lastConnectedAt != rhs.lastConnectedAt {
                        return lhs.lastConnectedAt > rhs.lastConnectedAt
                    }
                    return lhs.id < rhs.id
                }
                .prefix(maxPooled))
    }

    public static func merge(_ raw: [RecentJoin]) -> [RecentJoin] {
        var byId: [String: RecentJoin] = [:]
        for entry in raw {
            guard var winner = byId[entry.id] else {
                byId[entry.id] = entry
                continue
            }
            let earliest = min(winner.firstConnectedAt, entry.firstConnectedAt)
            if entry.lastConnectedAt > winner.lastConnectedAt {
                let label = winner.label
                winner = entry
                if winner.label.isEmpty { winner.label = label }
            } else if winner.label.isEmpty {
                winner.label = entry.label
            }

            winner.firstConnectedAt = earliest
            byId[entry.id] = winner
        }
        return Array(byId.values)
    }

    private func decodeOwn() -> [RecentJoin] {
        decode(key: ownKey)
    }

    private func decodeAll() -> [RecentJoin] {
        backend.keys(withPrefix: Self.storageKeyPrefix).flatMap { decode(key: $0) }
    }

    private func decode(key: String) -> [RecentJoin] {
        guard let data = backend.data(forKey: key) else { return [] }
        do {
            return try JSONDecoder().decode([RecentJoin].self, from: data)
        } catch {
            recentsLog.error("decode: failed to decode payload: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private func persistOwn(_ list: [RecentJoin]) {
        do {
            let data = try JSONEncoder().encode(list)
            backend.setData(data, forKey: ownKey)
            _ = backend.synchronize()
        } catch {
            recentsLog.error("persistOwn: failed to encode payload: \(error.localizedDescription, privacy: .public)")
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
