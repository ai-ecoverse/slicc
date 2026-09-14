import SwiftUI
import WidgetKit





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













public enum UnitsWidgetCapacity {
    
    public static let smallGrid = 4
    public static let smallStrip = 5
    
    public static let mediumField = 6
    
    
    
    
    public static let largeField = 6
    
    public static let largeMessageLines = 5
}

















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
                    
                    
                    guard let leftAt else { return false }
                    guard let rightAt else { return true }
                    return leftAt > rightAt
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    
    public static func split(_ snapshot: WidgetSnapshot, count: Int) -> (head: [WidgetUnit], tail: [WidgetUnit]) {
        let ranked = ranked(snapshot)
        return (Array(ranked.prefix(count)), Array(ranked.dropFirst(count)))
    }
}








public struct UnitsWidgetSmall: View {
    public let context: WidgetRenderContext
    @Environment(\.colorScheme) private var scheme

    public init(context: WidgetRenderContext) { self.context = context }

    
    
    
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



#if os(iOS)
    
    
    
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
