import Foundation

/// The one-way drop box between the host app and its widget extension.
///
/// A JSON file in the shared app-group container, not `UserDefaults`: the
/// snapshot is a document (tens of units, a few KB), `UserDefaults` in a group
/// container is a coalescing cache with no ordering guarantee against a
/// process that is not running, and an atomic file replace gives the widget a
/// read that is either the old snapshot or the new one and never half of both.
///
/// The store is deliberately blind to WHO writes it. On iOS that is the
/// follower app draining `scoops.list`; on macOS it is Sliccstart's own tray
/// connection. Both ends see the same file name in their own group.
public struct WidgetSnapshotStore {
    /// App group the host app and the widget share. iOS uses
    /// `group.ai.sliccy.follower` (already carried by the app, the share
    /// extension and the File Provider); macOS uses the team-prefixed
    /// `S8LB56P782.com.slicc.sliccstart.fileprovider`.
    public let appGroup: String
    /// File name inside the group container.
    public let fileName: String

    /// Resolves the group container. Injected rather than called directly so
    /// a test can point the store at a temp directory — and so the missing
    /// container can be exercised at all. (On macOS `FileManager` hands back a
    /// path for an unentitled group and only fails on write; on iOS it returns
    /// nil. Both paths have to work.)
    private let containerURL: (String) -> URL?

    public init(
        appGroup: String,
        fileName: String = "widget-snapshot.json",
        containerURL: @escaping (String) -> URL? = { group in
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        }
    ) {
        self.appGroup = appGroup
        self.fileName = fileName
        self.containerURL = containerURL
    }

    /// Subdirectory the snapshot lives in, inside the group container.
    ///
    /// `Library/`, not the container root, and the reason is purely
    /// operational: `devicectl device copy from` refuses anything outside
    /// `Library`, `Documents` and `tmp`, so a snapshot at the root cannot be
    /// read off a real device at all — it does not even appear in a file
    /// listing. Debugging "why is the widget empty on my iPad" without being
    /// able to look at the one file involved is not a position worth being in.
    static let subdirectory = "Library"

    /// Absolute location of the snapshot file, or `nil` when the process holds
    /// no entitlement for the group (an unsigned dev build, a simulator build
    /// without the capability, a unit test).
    public var url: URL? {
        containerURL(appGroup)?
            .appendingPathComponent(Self.subdirectory)
            .appendingPathComponent(fileName)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    /// Serialize a snapshot. Split out from ``write(_:)`` so the encoding is
    /// testable without an entitled container.
    public static func encode(_ snapshot: WidgetSnapshot) throws -> Data {
        try encoder.encode(snapshot)
    }

    /// Parse a snapshot, rejecting one written by a schema this build does not
    /// understand rather than rendering a half-decoded instance.
    public static func decode(_ data: Data) throws -> WidgetSnapshot {
        let snapshot = try decoder.decode(WidgetSnapshot.self, from: data)
        guard snapshot.schema <= WidgetSnapshot.currentSchema else {
            throw WidgetSnapshotStoreError.futureSchema(snapshot.schema)
        }
        return snapshot
    }

    /// Replace the snapshot atomically. Callers follow it with
    /// `WidgetCenter.shared.reloadAllTimelines()`; this type does not import
    /// WidgetKit so it can be exercised from a plain test target.
    @discardableResult
    public func write(_ snapshot: WidgetSnapshot) throws -> URL {
        guard let url else { throw WidgetSnapshotStoreError.noContainer(appGroup) }
        // `Library/` exists in a real group container, but not in the temp
        // directory a test points this at — and an atomic write into a missing
        // directory fails on the rename, not the open, which is a confusing
        // way to find that out.
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encode(snapshot).write(to: url, options: .atomic)
        return url
    }

    /// The snapshot on disk, or `nil` when there is none / it is unreadable.
    /// Unreadable is not an error worth propagating to a timeline provider —
    /// the widget's answer either way is the unavailable state.
    public func read() -> WidgetSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decode(data)
    }

    /// Remove the snapshot — on disconnect-and-forget, so a widget cannot keep
    /// naming an instance the user has detached from.
    public func clear() {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

public enum WidgetSnapshotStoreError: Error, Equatable {
    /// The process is not entitled to the app group.
    case noContainer(String)
    /// Written by a newer build than this one.
    case futureSchema(Int)
}
