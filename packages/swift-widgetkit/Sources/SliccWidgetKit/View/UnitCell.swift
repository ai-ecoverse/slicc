import SwiftUI

/// One unit in the grid: its avatar and its name. Nothing else.
///
/// There is no status word, no model id and no context bar next to it on
/// purpose. All three said something the face already says — phase through the
/// eyes' shape, lids and gaze, fullness through pupil size — and three lines
/// of small grey text is what turns a glanceable tile into a form. If you
/// cannot tell what a unit is doing from its face, the face is the bug.
public struct UnitCell: View {
    public let unit: WidgetUnit
    public let palette: WidgetPalette
    public let avatarSize: Double
    public let nameSize: Double

    public init(unit: WidgetUnit, palette: WidgetPalette, avatarSize: Double, nameSize: Double) {
        self.unit = unit
        self.palette = palette
        self.avatarSize = avatarSize
        self.nameSize = nameSize
    }

    public var body: some View {
        VStack(spacing: nameSize * 0.35) {
            UnitAvatarView(
                geometry: unit.avatarGeometry(sideLength: avatarSize),
                hue: palette.avatarHue(for: unit),
                muted: unit.isDormant)
            Text(unit.name)
                .font(.system(size: nameSize, weight: unit.role == .cone ? .semibold : .regular))
                .foregroundStyle(unit.isDormant ? palette.inkSecondary : palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(unit.accessibilityPhrase())
    }
}

/// A fixed-column run of cells, with an optional `+N` in the last slot.
///
/// Fixed rather than `LazyVGrid`: a handful of cells never needs to be lazy,
/// and a fixed layout keeps a two-unit row from stretching each face across
/// half the tile.
public struct UnitGrid: View {
    public let units: [WidgetUnit]
    public let palette: WidgetPalette
    public let columns: Int
    public let avatarSize: Double
    public let nameSize: Double
    /// How many units this grid could not show. Stated, never silent.
    public var trailing: Int

    public init(
        units: [WidgetUnit], palette: WidgetPalette, columns: Int,
        avatarSize: Double, nameSize: Double, trailing: Int = 0
    ) {
        self.units = units
        self.palette = palette
        self.columns = columns
        self.avatarSize = avatarSize
        self.nameSize = nameSize
        self.trailing = trailing
    }

    var rows: [[WidgetUnit]] {
        let columns = max(1, self.columns)
        return stride(from: 0, to: units.count, by: columns).map {
            Array(units[$0..<min($0 + columns, units.count)])
        }
    }

    public var body: some View {
        let columns = max(1, self.columns)
        VStack(spacing: avatarSize * 0.22) {
            ForEach(Array(rows.enumerated()), id: \.offset) { row in
                HStack(alignment: .top, spacing: avatarSize * 0.2) {
                    ForEach(row.element) { unit in
                        UnitCell(
                            unit: unit, palette: palette,
                            avatarSize: avatarSize, nameSize: nameSize)
                    }
                    if row.offset == rows.count - 1, trailing > 0 {
                        Text("+\(trailing)")
                            .font(.system(size: nameSize + 2, weight: .medium))
                            .foregroundStyle(palette.inkTertiary)
                            .frame(maxWidth: .infinity)
                    }
                    // Pad a short row so two units do not spread out into a
                    // full row's worth of space.
                    let filled = row.element.count + (row.offset == rows.count - 1 && trailing > 0 ? 1 : 0)
                    if filled < columns {
                        ForEach(0..<(columns - filled), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
    }
}

/// The overflow row under the grid: every unit the grid had no cell for, as
/// its own avatar.
///
/// Not a count and not anonymous pips — a strip of real avatars still says
/// which units they are and what each is doing, which is the only reason to
/// spend the pixels. The `+N` appears only when the strip itself overflows,
/// because a cap that is not stated reads as "that is everything".
public struct UnitOverflowStrip: View {
    public let units: [WidgetUnit]
    public let palette: WidgetPalette
    public let avatarSize: Double
    /// How many fit before the strip starts counting.
    public let limit: Int

    public init(units: [WidgetUnit], palette: WidgetPalette, avatarSize: Double, limit: Int) {
        self.units = units
        self.palette = palette
        self.avatarSize = avatarSize
        self.limit = limit
    }

    public var hidden: Int { max(0, units.count - limit) }

    public var body: some View {
        HStack(spacing: avatarSize * 0.25) {
            ForEach(units.prefix(limit)) { unit in
                UnitAvatarView(
                    geometry: unit.avatarGeometry(sideLength: avatarSize),
                    hue: palette.avatarHue(for: unit),
                    muted: unit.isDormant)
            }
            if hidden > 0 {
                Text("+\(hidden)")
                    .font(.system(size: avatarSize * 0.6, weight: .medium))
                    .foregroundStyle(palette.inkTertiary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityPhrase)
    }

    var accessibilityPhrase: String {
        let shown = units.prefix(limit).map(\.name).joined(separator: ", ")
        return hidden > 0 ? "Also \(shown), and \(hidden) more" : "Also \(shown)"
    }
}

/// Instance identity + connection, the widget's top line.
public struct InstanceHeader: View {
    public let snapshot: WidgetSnapshot
    public let palette: WidgetPalette
    public var now: Date
    public var fontSize: Double

    public init(snapshot: WidgetSnapshot, palette: WidgetPalette, now: Date, fontSize: Double = 10) {
        self.snapshot = snapshot
        self.palette = palette
        self.now = now
        self.fontSize = fontSize
    }

    public var body: some View {
        HStack(spacing: 5) {
            Text(snapshot.instanceLabel)
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(palette.inkSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 2)
            if let staleness = stalenessText {
                Text(staleness)
                    .font(.system(size: fontSize))
                    .foregroundStyle(palette.inkTertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            if let dot = palette.connectionColor(snapshot.connection) {
                Circle().fill(dot).frame(width: 5, height: 5)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// A capture time, not a countdown: "4m ago" is what a person needs to
    /// decide whether to trust the faces below it.
    var stalenessText: String? {
        guard snapshot.isStale(asOf: now), snapshot.connection != .none else { return nil }
        let elapsed = max(0, now.timeIntervalSince(snapshot.capturedAt))
        if elapsed < 60 { return "just now" }
        if elapsed < 3600 { return "\(Int(elapsed / 60))m ago" }
        if elapsed < 86400 { return "\(Int(elapsed / 3600))h ago" }
        return "\(Int(elapsed / 86400))d ago"
    }
}

/// What the widget shows with no instance behind it: an avatar with a dead
/// signal — eyes full of frozen TV static — over one line of what to do about
/// it. The app already uses this treatment for a feed with nothing behind it,
/// so it is the product's own word for "nothing here", not a new one.
public struct UnavailableView: View {
    public let snapshot: WidgetSnapshot
    public let palette: WidgetPalette
    public let host: WidgetHost
    public var avatarSize: Double
    public var compact: Bool

    public init(
        snapshot: WidgetSnapshot, palette: WidgetPalette, host: WidgetHost,
        avatarSize: Double = 56, compact: Bool = false
    ) {
        self.snapshot = snapshot
        self.palette = palette
        self.host = host
        self.avatarSize = avatarSize
        self.compact = compact
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 10) {
            Spacer(minLength: 0)
            UnitAvatarView(
                geometry: UnitAvatarGeometry(type: .cone, eyes: .static, sideLength: avatarSize),
                hue: palette.inkTertiary)
            Text(headline)
                .font(.system(size: compact ? 12 : 14, weight: .semibold))
                .foregroundStyle(palette.inkSecondary)
                .lineLimit(1)
            Text(detail)
                .font(.system(size: compact ? 10 : 11))
                .foregroundStyle(palette.inkTertiary)
                .lineLimit(compact ? 3 : 2)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    var headline: String {
        snapshot.connection == .none ? "No instance" : "Not connected"
    }

    var detail: String {
        snapshot.connection == .none
            ? "Join a SLICC session to see its cones and scoops."
            : "Open \(host.appName) to reconnect to \(snapshot.instanceLabel)."
    }
}

/// Everything below the header dims when the snapshot is not live.
///
/// The header already says "56m ago"; this makes the same fact legible from
/// across the room, where the only thing a glance resolves is contrast.
extension View {
    public func stale(_ isStale: Bool) -> some View {
        opacity(isStale ? 0.55 : 1)
    }
}

/// The last turn in the session, printed under the faces on the one family
/// with room for it.
///
/// Marked `privacySensitive`: iOS redacts it on a locked device, which is the
/// only correct default for arbitrary conversation text sitting on a home
/// screen. The faces above it stay visible — a cone's mood is not a secret,
/// the sentence it just wrote might be.
public struct LastMessageView: View {
    public let message: WidgetMessage
    /// The unit that said it, when it is still in the snapshot.
    public let unit: WidgetUnit?
    public let palette: WidgetPalette
    public var now: Date
    public var lineLimit: Int

    public init(
        message: WidgetMessage, unit: WidgetUnit?, palette: WidgetPalette,
        now: Date, lineLimit: Int = 4
    ) {
        self.message = message
        self.unit = unit
        self.palette = palette
        self.now = now
        self.lineLimit = lineLimit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                if let unit, message.author == .agent {
                    UnitAvatarView(
                        geometry: unit.avatarGeometry(sideLength: 16),
                        hue: palette.avatarHue(for: unit),
                        muted: unit.isDormant)
                }
                Text(attribution)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.inkSecondary)
                    .lineLimit(1)
                Spacer(minLength: 2)
                if let elapsed {
                    Text(elapsed)
                        .font(.system(size: 10))
                        .foregroundStyle(palette.inkTertiary)
                        .fixedSize()
                }
            }
            Text(message.text)
                .font(.system(size: 12))
                .foregroundStyle(palette.ink)
                .lineLimit(lineLimit)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .privacySensitive()
        }
        .accessibilityElement(children: .combine)
    }

    var attribution: String {
        switch message.author {
        case .user: "You"
        case .agent: unit?.name ?? "Agent"
        }
    }

    /// Relative to the message, not to the capture: a snapshot taken now can
    /// carry a turn from an hour ago, and "1h ago" on the text is the honest
    /// thing to print even when the header says the link is live.
    var elapsed: String? {
        guard let at else { return nil }
        let seconds = max(0, now.timeIntervalSince(at))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86400))d ago"
    }

    private var at: Date? { message.at }
}
