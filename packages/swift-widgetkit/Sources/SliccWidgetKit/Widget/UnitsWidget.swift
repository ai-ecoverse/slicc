import SwiftUI
import WidgetKit


public struct UnitsEntry: TimelineEntry {
    public let date: Date
    public let snapshot: WidgetSnapshot

    public init(date: Date, snapshot: WidgetSnapshot) {
        self.date = date
        self.snapshot = snapshot
    }
}










public struct UnitsTimelineProvider: TimelineProvider {
    public let host: WidgetHost
    
    public let clock: @Sendable () -> Date

    public init(host: WidgetHost, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.host = host
        self.clock = clock
    }

    
    public func placeholder(in context: Context) -> UnitsEntry {
        UnitsEntry(date: WidgetSnapshot.fixtureCaptureDate, snapshot: .fixtureBusy)
    }

    
    
    
    public func getSnapshot(in context: Context, completion: @escaping (UnitsEntry) -> Void) {
        if context.isPreview {
            completion(UnitsEntry(date: WidgetSnapshot.fixtureCaptureDate, snapshot: .fixtureBusy))
        } else {
            completion(UnitsEntry(date: clock(), snapshot: currentSnapshot()))
        }
    }

    public func getTimeline(in context: Context, completion: @escaping (Timeline<UnitsEntry>) -> Void) {
        let now = clock()
        let entry = UnitsEntry(date: now, snapshot: currentSnapshot())
        completion(Timeline(entries: [entry], policy: .after(now.addingTimeInterval(Self.heartbeat))))
    }

    
    public static let heartbeat: TimeInterval = 15 * 60

    
    
    
    
    
    
    
    public func currentSnapshot() -> WidgetSnapshot {
        if let stored = host.store.read() { return stored }
        #if SLICC_WIDGET_DESIGN_FIXTURES
            return .fixtureBusy
        #else
            return .unavailable()
        #endif
    }
}








public enum UnitsWidget {
    
    
    
    public static let kind = "ai.sliccy.widget.units"
    public static let displayName = "Cones & Scoops"
    public static let description = "What the agents in your SLICC session are doing right now."

    
    
    public static let iOSFamilies: [WidgetFamily] = {
        #if os(iOS)
            [.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline]
        #else
            [.systemSmall, .systemMedium, .systemLarge]
        #endif
    }()

    public static let macFamilies: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
}


public func unitsWidgetConfiguration(host: WidgetHost, families: [WidgetFamily]) -> some WidgetConfiguration {
    StaticConfiguration(kind: UnitsWidget.kind, provider: UnitsTimelineProvider(host: host)) { entry in
        UnitsWidgetEntryView(
            context: WidgetRenderContext(snapshot: entry.snapshot, now: entry.date, host: host))
    }
    .configurationDisplayName(UnitsWidget.displayName)
    .description(UnitsWidget.description)
    .supportedFamilies(families)
}
