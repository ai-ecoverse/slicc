import SwiftUI
import WidgetKit

/// One rendered widget: a snapshot, the moment it is being drawn at, and which
/// app it belongs to. `now` is a parameter and never `Date()` — a widget's
/// timeline is composed ahead of time, and a view that reads the clock renders
/// a different thing than the timeline promised.
public struct WidgetRenderContext: Equatable, Sendable {
    public let snapshot: WidgetSnapshot
    public let now: Date
    public let host: WidgetHost

    public init(snapshot: WidgetSnapshot, now: Date, host: WidgetHost) {
        self.snapshot = snapshot
        self.now = now
        self.host = host
    }
}

/// The three families answer three different questions, so they are three
/// layouts rather than one layout at three scales.
///
/// - **small** — *who needs me?* Four peers in a 2x2, ranked by attention.
/// - **medium** — *what is the one thing, and what else is going on?* The
///   leading unit large on the left, the rest as a compact field on the right.
///   The tile is twice as wide as it is tall; that shape wants a focus and a
///   margin, not four equal squares with air above and below them.
/// - **large** — *what did it just say?* Medium's focus and field at a larger
///   size, and then the height that is left goes to the last turn in the
///   session. The extra 200pt is better spent on a sentence you can read than
///   on a second arrangement of the same faces.
public enum UnitsWidgetCapacity {
    /// Small: the 2x2 and the strip beneath it.
    public static let smallGrid = 4
    public static let smallStrip = 5
    /// Medium: one focus plus a 3x2 field.
    public static let mediumField = 6
    /// Large: one focus plus a 3x2 field, then the message. Three columns,
    /// not four: at four the field's minimum width plus the focus overflows
    /// the 308pt of content the tile actually has, and an HStack that cannot
    /// fit centres itself and bleeds off both edges.
    public static let largeField = 6
    /// Lines of the last turn the large family prints.
    public static let largeMessageLines = 5
}

/// Which units earn the scarce cells, and in what order.
///
/// **Cones first, always. Then scoops, if any. Each group by recency.**
///
/// Not by urgency. Sorting the whole list by attention floated a broken scoop
/// above the cone that owns it, which reads as though the scoop were the
/// session — and with several cones coming, "which cone" is the first question
/// a glance asks, not "what is on fire". A cone is a thing you talk to; a
/// scoop is a thing you watch.
///
/// Urgency is not lost, it just stops outranking structure: breaking IS a
/// change, so a unit that just broke carries a fresh stamp from
/// ``UnitRecencyLedger`` and rises to the top of its own group.
///
/// Wire order breaks the last tie, so units the capture side has never seen
/// move (no stamp at all) hold a stable position instead of shuffling.
public enum UnitRanking {
    public static func ranked(_ snapshot: WidgetSnapshot) -> [WidgetUnit] {
        snapshot.units.enumerated()
            .sorted { lhs, rhs in
                let leftIsCone = lhs.element.role == .cone
                let rightIsCone = rhs.element.role == .cone
                if leftIsCone != rightIsCone { return leftIsCone }
                let leftAt = lhs.element.lastActivityAt
                let rightAt = rhs.element.lastActivityAt
                if leftAt != rightAt {
                    // A stamped unit outranks an unstamped one: "we have never
                    // seen this move" is not a claim to recency.
                    guard let leftAt else { return false }
                    guard let rightAt else { return true }
                    return leftAt > rightAt
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// The first `count` units and everything after them, in one pass.
    public static func split(_ snapshot: WidgetSnapshot, count: Int) -> (head: [WidgetUnit], tail: [WidgetUnit]) {
        let ranked = ranked(snapshot)
        return (Array(ranked.prefix(count)), Array(ranked.dropFirst(count)))
    }
}

// MARK: - Small

/// Small: four peers, 2x2, ranked by attention, with the rest as a strip.
///
/// A 158pt tile holds four faces at a legible size and nothing more, so this
/// family does not try to say anything about ownership — it answers "who needs
/// me" and stops.
public struct UnitsWidgetSmall: View {
    public let context: WidgetRenderContext
    @Environment(\.colorScheme) private var scheme

    public init(context: WidgetRenderContext) { self.context = context }

    /// Fewer units get bigger faces. A one-cone session is the common case on
    /// day one and must not look like a bug: rather than parking a 34pt avatar
    /// in the corner of the tile, a lone cone fills it.
    public static func avatarSize(for count: Int) -> Double {
        switch count {
        case ...1: 64
        case 2: 46
        default: 34
        }
    }

    public var body: some View {
        let palette = WidgetPalette.resolve(scheme)
        if context.snapshot.isUnavailable {
            UnavailableView(
                snapshot: context.snapshot, palette: palette, host: context.host,
                avatarSize: 44, compact: true)
        } else {
            let split = UnitRanking.split(context.snapshot, count: UnitsWidgetCapacity.smallGrid)
            let size = Self.avatarSize(for: split.head.count)
            VStack(alignment: .leading, spacing: 0) {
                InstanceHeader(
                    snapshot: context.snapshot, palette: palette, now: context.now, fontSize: 9)
                Spacer(minLength: 4)
                Group {
                    if split.head.isEmpty {
                        emptyCone(palette: palette)
                    } else {
                        UnitGrid(
                            units: split.head, palette: palette,
                            columns: min(2, max(1, split.head.count)),
                            avatarSize: size, nameSize: 9)
                    }
                    if !split.tail.isEmpty {
                        Spacer(minLength: 6)
                        UnitOverflowStrip(
                            units: split.tail, palette: palette, avatarSize: 13,
                            limit: UnitsWidgetCapacity.smallStrip)
                    }
                }
                .stale(context.snapshot.isStale(asOf: context.now))
            }
        }
    }

    private func emptyCone(palette: WidgetPalette) -> some View {
        Text("No cone yet")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(palette.inkSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Focus + field

/// The leading unit large, the rest small beside it. Shared by medium and
/// large, because the arrangement earns its place on both: the tile is wider
/// than it is tall, and one face at full height plus a field of the rest is
/// what that shape wants.
struct FocusAndFieldRow: View {
    let context: WidgetRenderContext
    let palette: WidgetPalette
    let focusSize: Double
    let focusNameSize: Double
    let fieldSize: Double
    let fieldNameSize: Double
    let fieldColumns: Int
    let fieldLimit: Int

    var body: some View {
        let split = UnitRanking.split(context.snapshot, count: 1)
        HStack(alignment: .center, spacing: 14) {
            // With nothing to put beside it, the focus takes the middle of the
            // tile rather than hugging the left edge with two thirds of the
            // widget left as air.
            if split.tail.isEmpty { Spacer(minLength: 0) }
            if let focus = split.head.first {
                UnitCell(
                    unit: focus, palette: palette,
                    avatarSize: split.tail.isEmpty ? focusSize * 1.2 : focusSize,
                    nameSize: focusNameSize
                )
                .fixedSize(horizontal: true, vertical: false)
            } else {
                Text("No cone yet")
                    .font(.system(size: focusNameSize + 2, weight: .semibold))
                    .foregroundStyle(palette.inkSecondary)
            }
            if !split.tail.isEmpty {
                UnitGrid(
                    units: Array(split.tail.prefix(fieldLimit)), palette: palette,
                    columns: fieldColumns, avatarSize: fieldSize, nameSize: fieldNameSize,
                    trailing: split.tail.count - min(split.tail.count, fieldLimit))
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Medium

/// Medium: one face large, the rest small beside it.
///
/// The tile is 338x158 — twice as wide as it is tall. Four equal squares in a
/// row leave a band of air above and below every one of them; a focus plus a
/// field uses the whole height for the unit that earned it and spends the
/// remainder on context.
public struct UnitsWidgetMedium: View {
    public let context: WidgetRenderContext
    @Environment(\.colorScheme) private var scheme

    public init(context: WidgetRenderContext) { self.context = context }

    public var body: some View {
        let palette = WidgetPalette.resolve(scheme)
        if context.snapshot.isUnavailable {
            UnavailableView(
                snapshot: context.snapshot, palette: palette, host: context.host, avatarSize: 52)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                InstanceHeader(
                    snapshot: context.snapshot, palette: palette, now: context.now, fontSize: 10)
                Spacer(minLength: 4)
                FocusAndFieldRow(
                    context: context, palette: palette,
                    focusSize: 84, focusNameSize: 11,
                    fieldSize: 38, fieldNameSize: 8,
                    fieldColumns: 3, fieldLimit: UnitsWidgetCapacity.mediumField
                )
                .frame(maxHeight: .infinity)
                .stale(context.snapshot.isStale(asOf: context.now))
            }
        }
    }
}

// MARK: - Large

/// Large: medium's faces, then what was actually said.
///
/// The large tile is the medium tile plus ~200pt of height. Rearranging the
/// same faces into that space only produced medium at 3x; the height is better
/// spent on the one thing no other family can show — the last turn, in words.
/// That is also the thing you would have opened the app for.
public struct UnitsWidgetLarge: View {
    public let context: WidgetRenderContext
    @Environment(\.colorScheme) private var scheme

    public init(context: WidgetRenderContext) { self.context = context }

    public var body: some View {
        let palette = WidgetPalette.resolve(scheme)
        if context.snapshot.isUnavailable {
            UnavailableView(
                snapshot: context.snapshot, palette: palette, host: context.host, avatarSize: 76)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                InstanceHeader(
                    snapshot: context.snapshot, palette: palette, now: context.now, fontSize: 11)
                Spacer(minLength: 6)
                Group {
                    FocusAndFieldRow(
                        context: context, palette: palette,
                        focusSize: 104, focusNameSize: 12,
                        fieldSize: 44, fieldNameSize: 9,
                        fieldColumns: 3, fieldLimit: UnitsWidgetCapacity.largeField)
                    Spacer(minLength: 10)
                    message(palette: palette)
                }
                .stale(context.snapshot.isStale(asOf: context.now))
            }
        }
    }

    /// The last turn, or the reason there is not one. An empty frame here
    /// would read as a rendering failure rather than as a quiet session.
    @ViewBuilder
    private func message(palette: WidgetPalette) -> some View {
        Rectangle().fill(palette.inkTertiary.opacity(0.25)).frame(height: 0.5)
        Spacer(minLength: 10)
        if let last = context.snapshot.lastMessage {
            LastMessageView(
                message: last, unit: context.snapshot.lastMessageUnit,
                palette: palette, now: context.now,
                lineLimit: UnitsWidgetCapacity.largeMessageLines)
        } else {
            Text("Nothing said yet")
                .font(.system(size: 12))
                .foregroundStyle(palette.inkTertiary)
        }
        Spacer(minLength: 0)
    }
}

// MARK: - Accessory (iOS lock screen / StandBy)

#if os(iOS)
    /// Lock-screen circular: the focused cone's context fill as a gauge.
    /// Monochrome by policy up here, so the quantity goes on the gauge and the
    /// category (which the face carries everywhere else) does not.
    public struct UnitsWidgetCircular: View {
        public let context: WidgetRenderContext

        public init(context: WidgetRenderContext) { self.context = context }

        public var body: some View {
            let cone = context.snapshot.primaryCone
            Gauge(value: (cone?.fill ?? 0) / 100) {
                UnitMarkView(role: .cone, size: 11)
            } currentValueLabel: {
                Text("\(Int((cone?.fill ?? 0).rounded()))")
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .accessibilityLabel(cone?.accessibilityPhrase() ?? "No cone")
        }
    }

    /// Lock-screen rectangular. The one surface that still spells the status
    /// out: `.widgetAccentable()` flattens the avatar to a silhouette up here,
    /// so the face cannot carry the phase and a word has to.
    public struct UnitsWidgetRectangular: View {
        public let context: WidgetRenderContext

        public init(context: WidgetRenderContext) { self.context = context }

        public var body: some View {
            let lead = UnitRanking.ranked(context.snapshot).first
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    UnitMarkView(role: lead?.role ?? .cone, size: 11)
                    Text(lead?.name ?? context.host.appName)
                        .font(.headline)
                        .lineLimit(1)
                }
                Text(lead?.statusWord ?? "not connected")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(tally)
                    .font(.system(size: 11))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetAccentable()
        }

        var tally: String {
            let busy = context.snapshot.busyCount
            let units = context.snapshot.units.count
            guard units > 0 else { return "no units" }
            return busy > 0 ? "\(units) units · \(busy) working" : "\(units) units · all idle"
        }
    }

    /// Inline (above the lock-screen clock): one clause, no glyph of our own —
    /// the system supplies the app icon.
    public struct UnitsWidgetInline: View {
        public let context: WidgetRenderContext

        public init(context: WidgetRenderContext) { self.context = context }

        public var body: some View {
            Text(phrase)
        }

        var phrase: String {
            guard let lead = UnitRanking.ranked(context.snapshot).first else {
                return "No SLICC instance"
            }
            let busy = context.snapshot.busyCount
            return busy > 1
                ? "\(lead.name) \(lead.statusWord) · \(busy) working"
                : "\(lead.name) \(lead.statusWord)"
        }
    }
#endif

// MARK: - Family switch

/// The widget's entry view: pick a layout by family, paint the container
/// background WidgetKit requires, and hand the whole tile a tap target.
public struct UnitsWidgetEntryView: View {
    public let context: WidgetRenderContext
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    public init(context: WidgetRenderContext) { self.context = context }

    public var body: some View {
        layout
            .containerBackground(for: .widget) {
                WidgetPalette.resolve(scheme).canvas
            }
            .widgetURL(UnitRanking.ranked(context.snapshot).first.flatMap(context.host.url(forUnit:)))
    }

    @ViewBuilder
    private var layout: some View {
        switch family {
        case .systemSmall:
            UnitsWidgetSmall(context: context)
        case .systemMedium:
            UnitsWidgetMedium(context: context)
        case .systemLarge, .systemExtraLarge:
            UnitsWidgetLarge(context: context)
        #if os(iOS)
            case .accessoryCircular:
                UnitsWidgetCircular(context: context)
            case .accessoryRectangular:
                UnitsWidgetRectangular(context: context)
            case .accessoryInline:
                UnitsWidgetInline(context: context)
        #endif
        default:
            UnitsWidgetMedium(context: context)
        }
    }
}
