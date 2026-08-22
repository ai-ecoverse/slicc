import Foundation
import Observation
import os

private let recentsLog = Logger(subsystem: "ai.sliccy.traysession", category: "RecentJoinStore")

/// One join URL this Apple ID has actually connected to, from any device.
///
/// `TraySessionSyncStore` answers "what is live right now" and only the macOS
/// launcher can publish into it. Recents answer the other half: a join URL
/// pasted into the phone by hand — or handed over by a deep link — is
/// otherwise unreachable from a second device, because nothing ever wrote it
/// anywhere shared. A connection that succeeded is the signal worth keeping.
public struct RecentJoin: Codable, Equatable, Identifiable {
    /// SHA-256 of the join URL, sharing `SyncedTraySession`'s derivation so a
    /// recent and the live session it came from collapse to one identity (and
    /// so the id is safe in accessibility identifiers and telemetry, which the
    /// secret-bearing `joinUrl` never is).
    public let id: String
    /// Full leader join URL (carries the session secret). Never rendered, never
    /// logged — `displayHost` is what a row may show.
    public var joinUrl: String
    /// Human-facing label if one was known at connect time ("Chrome on Lars's
    /// MacBook"), empty for a hand-pasted URL nobody named.
    public var label: String
    /// Stable per-device identity of the device that made the connection.
    public var deviceId: String
    /// Human-facing name of that device — display only, ownership keys on
    /// `deviceId`.
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

    /// The only part of a join URL safe to put on screen: host (with port when
    /// non-default). The path segment carries the session secret and stays
    /// here, so a row for an unlabelled paste still has something to say.
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

/// Cross-device history of join URLs that actually connected, backed by the
/// same iCloud key-value transport as `TraySessionSyncStore` under its own
/// key namespace.
///
/// Per-device keys, union reads, and the graceful-degradation story are
/// identical to the session store: each device only ever writes
/// `storageKeyPrefix + deviceId`, so two phones recording at once cannot
/// clobber each other, and an unprovisioned build degrades to a local cache
/// that simply never leaves the device.
///
/// The pool is deliberately larger than the five rows a consumer shows:
/// ranking sinks unreachable entries, and a live-but-older session can only
/// take a dead-but-newer one's place if it survived the merge.
@Observable
public final class RecentJoinStore {
    public static let storageKeyPrefix = "recentJoins.v1."
    /// A recent is history, not liveness — it outlives the session store's 12h
    /// TTL by a long way. Reachability, not age, is what demotes a dead row.
    public static let defaultTTL: TimeInterval = 30 * 24 * 60 * 60
    /// How many rows a consumer shows, and how many each device persists.
    public static let maxRecents = 5
    /// Ceiling on the merged pool, so a household of many devices cannot grow
    /// the decoded view without bound.
    public static let maxPooled = 20

    /// Merged, non-stale recents from every device, newest-connected first.
    /// Observable. Ranking for display is `rank(_:isReachable:)`.
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

    // MARK: - Read

    public func reload() {
        recents = Self.active(from: decodeAll(), ttl: ttl, now: clock())
    }

    /// Display order: reachable (or not-yet-probed) first, then most recently
    /// connected, capped at `limit`. Reachability outranks recency on purpose
    /// — a dead row is worthless however fresh it is — and the cap is applied
    /// *after* ranking so a live older session can displace a dead newer one.
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
            // Total order, so equal timestamps cannot reshuffle between redraws.
            return lhs.id < rhs.id
        }
        return Array(ordered.prefix(max(0, limit)))
    }

    /// Convenience over the store's own merged pool.
    public func ranked(
        limit: Int = RecentJoinStore.maxRecents,
        isReachable: (String) -> Bool
    ) -> [RecentJoin] {
        Self.rank(recents, limit: limit, isReachable: isReachable)
    }

    // MARK: - Write

    /// Remember a join URL that just connected. Only ever writes this device's
    /// own key. Recording on *success* rather than on dial is what keeps a
    /// typo'd paste out of everyone else's list.
    public func record(joinUrl: String, label: String) {
        let trimmed = joinUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let now = clock()
        var own = decodeOwn()
        let existing = own.first { $0.id == SyncedTraySession.identifier(forJoinUrl: trimmed) }
        let entry = RecentJoin(
            joinUrl: trimmed,
            // A later connect that knows no label must not erase the name an
            // earlier one learned.
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

    /// Drop one entry from this device's own key. A copy another device
    /// recorded survives — nothing here can write another device's key — so a
    /// row may reappear from iCloud; `clearLocalHistory` has the same limit.
    public func forget(id: String) {
        persistOwn(Self.active(from: decodeOwn().filter { $0.id != id }, ttl: ttl, now: clock()))
    }

    /// Clear every recent this device recorded (Settings → Clear Stored Data).
    public func clearLocalHistory() {
        backend.setData(nil, forKey: ownKey)
        _ = backend.synchronize()
        reload()
    }

    // MARK: - Pure helpers (unit-testable without a backend)

    /// Drop stale entries, collapse the same join URL recorded on several
    /// devices into one, and order newest-connected first.
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

    /// One entry per join URL: the most recent connection wins the device
    /// attribution, the earliest known first-connect survives, and a label
    /// learned anywhere beats an empty one.
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
            // Survives whichever side won the attribution: the first time this
            // Apple ID ever connected is not the newer device's answer to give.
            winner.firstConnectedAt = earliest
            byId[entry.id] = winner
        }
        return Array(byId.values)
    }

    // MARK: - Backend plumbing

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
