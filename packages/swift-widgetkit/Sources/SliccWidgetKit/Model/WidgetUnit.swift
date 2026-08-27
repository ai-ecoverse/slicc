import Foundation

/// One work unit (#1666) as a widget renders it — the read-only projection of
/// `ScoopSummary` from `packages/shared-ts/src/tray-sync-protocol.ts`.
///
/// A widget process cannot hold a tray connection, so it never sees the wire
/// type: the host app captures a snapshot and parks it in the shared app
/// group. This is deliberately a SEPARATE type from `ScoopSummary` rather than
/// a re-export — the widget must keep decoding snapshots written by an older
/// build of the app, so its shape is versioned by `WidgetSnapshot.schema` and
/// evolves on its own clock.
public struct WidgetUnit: Codable, Identifiable, Hashable, Sendable {
    /// Presentation role, the mirror of `UnitRole` in the app.
    public enum Role: String, Codable, Sendable {
        case cone
        case scoop
    }

    /// Agent lifecycle, the CLOSED four-value vocabulary of `ScoopSummary.state`
    /// plus the "leader never said" case. Refinements ride ``activity``.
    public enum Lifecycle: String, Codable, CaseIterable, Sendable {
        case working
        case broken
        case initializing
        case idle
        case unknown
    }

    /// Optional refinement of ``Lifecycle`` (`ScoopSummary.activity`). An
    /// unrecognised value decodes to `nil` and the lifecycle alone decides.
    public enum Activity: String, Codable, CaseIterable, Sendable {
        /// Busy waiting on or streaming from the model.
        case thinking
        /// Busy running a tool call.
        case tool
        /// Idle because the turn ended; the composer is the user's.
        case awaiting
    }

    /// `ScoopSummary.jid`.
    public let id: String
    /// The unit's display name (`ScoopSummary.assistantLabel`).
    public let name: String
    public let role: Role
    /// Ownership edge: `nil` for a cone, the owning unit's id for a scoop.
    public let parentId: String?
    public let lifecycle: Lifecycle
    public let activity: Activity?
    /// Context-window fullness on the 0...100 scale, or `nil` when unknown.
    public let fill: Double?
    /// Bare model id (`ScoopSummary.model.id`), shown only where there is room.
    public let model: String?
    /// One line of "what is this unit for" — `ScoopSummary.trigger`, the
    /// prompt or lick that spawned a scoop. The CAPTURE side truncates it: a
    /// widget snapshot is not a place to park a paragraph, and a scoop's
    /// trigger can be an entire user turn.
    public let detail: String?
    /// Whether this is the unit the leader currently has focused.
    public let isActive: Bool

    public init(
        id: String,
        name: String,
        role: Role,
        parentId: String? = nil,
        lifecycle: Lifecycle = .unknown,
        activity: Activity? = nil,
        fill: Double? = nil,
        model: String? = nil,
        detail: String? = nil,
        isActive: Bool = false
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.parentId = parentId
        self.lifecycle = lifecycle
        self.activity = activity
        self.fill = fill.map { $0.isFinite ? min(100, max(0, $0)) : 0 }
        self.model = model
        self.detail = detail
        self.isActive = isActive
    }

    /// Unknown enum values must not throw away the whole snapshot: a leader
    /// (or a newer app) that learns a fifth lifecycle should degrade this one
    /// unit to `unknown`, not blank the widget.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        role = Role(rawValue: try container.decode(String.self, forKey: .role)) ?? .scoop
        parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
        lifecycle =
            Lifecycle(rawValue: try container.decodeIfPresent(String.self, forKey: .lifecycle) ?? "")
            ?? .unknown
        activity = Activity(rawValue: try container.decodeIfPresent(String.self, forKey: .activity) ?? "")
        fill = try container.decodeIfPresent(Double.self, forKey: .fill)
            .map { $0.isFinite ? min(100, max(0, $0)) : 0 }
        model = try container.decodeIfPresent(String.self, forKey: .model)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? false
    }
}

extension WidgetUnit {
    /// The near-limit threshold the app already draws context fill against
    /// (`ScoopStatus.nearLimitThreshold`).
    public static let nearLimitThreshold = 75.0

    public var isNearLimit: Bool { (fill ?? 0) >= Self.nearLimitThreshold }

    /// Whether the unit is doing something right now. Drives the "n working"
    /// counts and the widget's own refresh cadence.
    public var isBusy: Bool { lifecycle == .working || lifecycle == .initializing }

    /// Nothing is happening and nothing is wanted — the only state whose
    /// avatar is allowed to recede.
    ///
    /// Two lifecycles that LOOK idle are excluded. `broken` is the loudest
    /// thing on the tile by intent; dimming the one unit that wants a human
    /// would invert the whole point. And `awaiting` is idle only because the
    /// turn ended and it is now waiting on YOU — receding is exactly the wrong
    /// signal for the one unit holding the ball.
    public var isDormant: Bool {
        (lifecycle == .idle && activity != .awaiting) || lifecycle == .unknown
    }

    /// The short status word a row or chip shows. `activity` refines
    /// `working` and `idle`; every other lifecycle speaks for itself.
    public var statusWord: String {
        switch (lifecycle, activity) {
        case (.working, .tool): "running a tool"
        case (.working, _): "thinking"
        case (.initializing, _): "starting"
        case (.broken, _): "needs you"
        case (.idle, .awaiting): "your turn"
        case (.idle, _): "idle"
        case (.unknown, _): "unknown"
        }
    }

    /// The same word where a row is narrow — the scoop list on the medium
    /// family, where the name is the thing worth the pixels. Only the two-word
    /// states differ; everything else stays identical so the two vocabularies
    /// cannot teach different things.
    public var shortStatusWord: String {
        lifecycle == .working && activity == .tool ? "tool" : statusWord
    }

    /// The unit's IDENTITY hue, the colour its avatar tile is painted in.
    ///
    /// Mirrors the leader's `scoopColor`: a cone is always waffle brown, a
    /// scoop takes one of six from a hash of its name, so the same scoop keeps
    /// the same colour everywhere it appears — the tab strip, the transcript,
    /// and now the home screen. The hash follows JS's `charCodeAt(0)`, which
    /// deliberately hashes only each scalar's first UTF-16 unit.
    public var avatarColorHex: String {
        if role == .cone { return "#b07823" }
        let palette = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"]
        let hash = name.unicodeScalars.reduce(UInt32.zero) { hash, scalar in
            let firstCodeUnit: UInt32 =
                scalar.value <= 0xFFFF
                ? scalar.value
                : 0xD800 + ((scalar.value - 0x10000) >> 10)
            return hash &* 31 &+ firstCodeUnit
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    /// The same fact in a form VoiceOver can read as a sentence.
    public func accessibilityPhrase() -> String {
        let kind = role == .cone ? "Cone" : "Scoop"
        let fillPhrase = fill.map { ", \(Int($0.rounded())) percent context" } ?? ""
        return "\(kind) \(name), \(statusWord)\(fillPhrase)"
    }
}
