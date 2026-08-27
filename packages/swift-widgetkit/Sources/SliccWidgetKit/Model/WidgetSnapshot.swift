import Foundation

/// Everything a SLICC widget draws, captured by the host app and read back by
/// the widget process.
///
/// A widget is not a follower. It cannot dial the leader, hold a data channel
/// or ask a question — WidgetKit gives it a few hundred milliseconds and a
/// hard memory budget, and it may run while the app is dead. So the contract
/// is one-way and lossy on purpose: the app writes the smallest honest
/// description of the instance it is connected to, and the widget renders that
/// description, including how old it is.
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    /// How the app's link to the instance looked when the snapshot was taken.
    public enum Connection: String, Codable, Sendable {
        /// Live data channel.
        case connected
        /// Channel up but the leader stopped answering pings — the app's
        /// `stalled` split, surfaced rather than hidden, because a widget that
        /// silently freezes on stale state is worse than one that says so.
        case stalled
        /// Known instance, no channel right now.
        case disconnected
        /// No instance has ever been joined on this device.
        case none
    }

    /// Bumped when a field's MEANING changes, never for additive fields. The
    /// widget refuses a snapshot from a future schema instead of guessing.
    public static let currentSchema = 1

    public let schema: Int
    /// Human label of the instance — the tray session label, else the host.
    public let instanceLabel: String
    /// What the instance is running in ("Chrome", "Electron", "Cloud", …), or
    /// `nil` when the app cannot tell.
    public let runtime: String?
    public let connection: Connection
    /// When the host app captured this. Drives the staleness treatment.
    public let capturedAt: Date
    /// Cone first, each cone followed by the scoops it owns.
    public let units: [WidgetUnit]
    /// The most recent turn in the session, for the one family with room to
    /// print it. `nil` when nothing has been said yet, or when the capture
    /// side chose not to include it.
    public let lastMessage: WidgetMessage?

    public init(
        schema: Int = WidgetSnapshot.currentSchema,
        instanceLabel: String,
        runtime: String? = nil,
        connection: Connection,
        capturedAt: Date,
        units: [WidgetUnit],
        lastMessage: WidgetMessage? = nil
    ) {
        self.schema = schema
        self.instanceLabel = instanceLabel
        self.runtime = runtime
        self.connection = connection
        self.capturedAt = capturedAt
        self.units = units
        self.lastMessage = lastMessage
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decodeIfPresent(Int.self, forKey: .schema) ?? Self.currentSchema
        instanceLabel = try container.decodeIfPresent(String.self, forKey: .instanceLabel) ?? "SLICC"
        runtime = try container.decodeIfPresent(String.self, forKey: .runtime)
        connection =
            Connection(rawValue: try container.decodeIfPresent(String.self, forKey: .connection) ?? "")
            ?? .none
        capturedAt = try container.decodeIfPresent(Date.self, forKey: .capturedAt) ?? Date(timeIntervalSince1970: 0)
        units = try container.decodeIfPresent([WidgetUnit].self, forKey: .units) ?? []
        lastMessage = try container.decodeIfPresent(WidgetMessage.self, forKey: .lastMessage)
    }
}

extension WidgetSnapshot {
    /// The state a widget shows when there is nothing to show. Distinct from
    /// an empty `units` list on a live connection, which means "connected, no
    /// cone yet" and gets its own copy.
    public static func unavailable(reason: Connection = .none) -> WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "SLICC",
            runtime: nil,
            connection: reason,
            capturedAt: Date(timeIntervalSince1970: 0),
            units: [],
            lastMessage: nil
        )
    }

    /// The cone (root) the widget leads with — the first root in wire order.
    /// A leader with several roots still has exactly one focused unit, so the
    /// leader's active root wins when there is one.
    public var primaryCone: WidgetUnit? {
        let roots = units.filter { $0.role == .cone }
        return roots.first(where: \.isActive) ?? roots.first
    }

    public var scoops: [WidgetUnit] { units.filter { $0.role == .scoop } }

    /// Scoops owned by `unit`, in wire order. Falls back to "every scoop" for
    /// snapshots written before the ownership edge existed.
    public func scoops(ownedBy unit: WidgetUnit) -> [WidgetUnit] {
        let owned = units.filter { $0.parentId == unit.id }
        return owned.isEmpty ? scoops.filter { $0.parentId == nil } : owned
    }

    public var busyCount: Int { units.filter(\.isBusy).count }

    /// A unit whose lifecycle is `broken` is the one thing on this widget
    /// worth interrupting someone for.
    public var brokenCount: Int { units.filter { $0.lifecycle == .broken }.count }

    /// True when the app has never captured anything, or captured a snapshot
    /// with no instance behind it.
    public var isUnavailable: Bool {
        connection == .none || (units.isEmpty && connection == .disconnected)
    }

    /// Past this the widget dims itself and prints the capture time. A tray
    /// connection that is alive pushes on every `scoops.list`, so anything
    /// this old means the app has not run in a while — not that nothing has
    /// happened.
    public static let stalenessHorizon: TimeInterval = 15 * 60

    public func isStale(asOf now: Date) -> Bool {
        connection != .connected || now.timeIntervalSince(capturedAt) > Self.stalenessHorizon
    }
}

/// The last thing said in the session, as a widget prints it.
///
/// Text only — no markdown, no attachments, no tool calls. The CAPTURE side
/// flattens and truncates it (`WidgetMessage.previewLimit`); a widget snapshot
/// is not a transcript, and a home screen is the last place to park one.
public struct WidgetMessage: Codable, Hashable, Sendable {
    public enum Author: String, Codable, Sendable {
        case agent
        case user
    }

    /// The most a snapshot should ever carry. Enough for four lines at large,
    /// small enough that the file stays a snapshot rather than a log.
    public static let previewLimit = 280

    public let author: Author
    /// The unit that said it, so the preview can wear that unit's face. `nil`
    /// for a user turn, or when the capture side could not attribute it.
    public let unitId: String?
    public let text: String
    /// When it was said. Separate from `WidgetSnapshot.capturedAt`: a snapshot
    /// taken now can carry a message from an hour ago.
    public let at: Date?

    public init(author: Author, unitId: String? = nil, text: String, at: Date? = nil) {
        self.author = author
        self.unitId = unitId
        self.text = String(text.prefix(Self.previewLimit))
        self.at = at
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        author =
            Author(rawValue: try container.decodeIfPresent(String.self, forKey: .author) ?? "")
            ?? .agent
        unitId = try container.decodeIfPresent(String.self, forKey: .unitId)
        text = String((try container.decodeIfPresent(String.self, forKey: .text) ?? "").prefix(Self.previewLimit))
        at = try container.decodeIfPresent(Date.self, forKey: .at)
    }
}

extension WidgetMessage {
    /// Flatten a markdown turn into the one line of plain text a widget can
    /// print, and cap it.
    ///
    /// Lives here, not in either app, because BOTH capture sides need exactly
    /// this and a widget that renders half-stripped markdown on one platform
    /// is the kind of drift nobody notices until a screenshot.
    ///
    /// Deliberately crude — it is a preview, not a renderer. Fenced code
    /// blocks go entirely (a widget printing three lines of a diff says
    /// nothing); inline formatting loses its markers; links keep their text;
    /// every run of whitespace becomes one space.
    public static func flatten(markdown: String) -> String {
        var text = markdown

        // Fenced code first: everything inside is dropped, so its contents
        // cannot be mistaken for prose by the passes below.
        text = text.replacingOccurrences(
            of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "`([^`]*)`", with: "$1", options: .regularExpression)
        // Images before links: an image's alt text is not worth printing.
        text = text.replacingOccurrences(
            of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        // Leading block markers: headings, quotes, list bullets, rules.
        text = text.replacingOccurrences(
            of: "(?m)^\\s{0,3}(#{1,6}\\s+|>\\s?|[-*+]\\s+|\\d+\\.\\s+)", with: "",
            options: .regularExpression)
        text = text.replacingOccurrences(
            of: "(?m)^\\s*([-*_])\\s*\\1\\s*\\1[-*_\\s]*$", with: " ",
            options: .regularExpression)
        // Emphasis markers, keeping the words between them.
        text = text.replacingOccurrences(
            of: "(\\*\\*|__|\\*|_|~~)", with: "", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "\\s+", with: " ", options: .regularExpression)

        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(previewLimit))
    }
}

extension WidgetSnapshot {
    /// The unit the last message came from, when it is still in the snapshot.
    public var lastMessageUnit: WidgetUnit? {
        guard let id = lastMessage?.unitId else { return nil }
        return units.first { $0.id == id }
    }
}
