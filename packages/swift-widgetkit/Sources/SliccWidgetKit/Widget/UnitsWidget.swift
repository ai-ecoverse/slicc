import SwiftUI
import WidgetKit

/// One timeline entry: the snapshot as of a moment.
public struct UnitsEntry: TimelineEntry {
    public let date: Date
    public let snapshot: WidgetSnapshot

    public init(date: Date, snapshot: WidgetSnapshot) {
        self.date = date
        self.snapshot = snapshot
    }
}

/// Reads the app-group snapshot and hands WidgetKit a single entry.
///
/// There is no polling here and no second entry in the future. A widget cannot
/// discover that a scoop finished — only the host app can, and when it does it
/// calls `WidgetCenter.shared.reloadAllTimelines()`. The one scheduled refresh
/// exists purely to age the "12m ago" line when the app has gone quiet, which
/// is why it is a quarter-hour and not a minute: WidgetKit's daily refresh
/// budget is small, and spending it on a clock nobody is watching is how a
/// widget ends up frozen at the moment it mattered.
public struct UnitsTimelineProvider: TimelineProvider {
    public let host: WidgetHost
    /// Injected so tests and previews can pin the clock.
    public let clock: @Sendable () -> Date

    public init(host: WidgetHost, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.host = host
        self.clock = clock
    }

    /// Redacted skeleton the system draws while the widget is being added.
    public func placeholder(in context: Context) -> UnitsEntry {
        UnitsEntry(date: WidgetSnapshot.fixtureCaptureDate, snapshot: .fixtureBusy)
    }

    /// The widget gallery's preview. Always the fixture: showing a real
    /// instance in the gallery would leak whatever the user is running to
    /// anyone flipping through widgets on a borrowed phone.
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

    /// Refresh cadence for the staleness line only — see the type comment.
    public static let heartbeat: TimeInterval = 15 * 60

    /// What the widget should draw right now.
    ///
    /// `SLICC_WIDGET_DESIGN_FIXTURES` is the not-yet-wired switch: nothing
    /// writes the snapshot file today, so a widget built with the flag renders
    /// the design fixtures instead of the empty state. Wiring the capture side
    /// means dropping the flag from the two `project.yml` targets — the read
    /// path below is already the real one.
    public func currentSnapshot() -> WidgetSnapshot {
        if let stored = host.store.read() { return stored }
        #if SLICC_WIDGET_DESIGN_FIXTURES
            return .fixtureBusy
        #else
            return .unavailable()
        #endif
    }
}

/// The "Cones & Scoops" widget's configuration, shared by both hosts.
///
/// `Widget` requires an `init()`, so the widget STRUCT has to live in each
/// extension — there is nowhere to hand it a host. What is shared is
/// everything below the struct: the kind, the copy, the families and the
/// configuration itself. Each extension's widget is four lines that call
/// ``unitsWidgetConfiguration(host:families:)``.
public enum UnitsWidget {
    /// Same kind string on both platforms, deliberately: the widget is one
    /// product surface, and someone who has it on an iPhone home screen and a
    /// Mac desktop should not have to learn two names for it.
    public static let kind = "ai.sliccy.widget.units"
    public static let displayName = "Cones & Scoops"
    public static let description = "What the agents in your SLICC session are doing right now."

    /// Families each host offers. iOS adds the lock-screen and StandBy
    /// accessories; macOS has none of those.
    public static let iOSFamilies: [WidgetFamily] = {
        #if os(iOS)
            [.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline]
        #else
            [.systemSmall, .systemMedium, .systemLarge]
        #endif
    }()

    public static let macFamilies: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
}

/// The whole widget, minus the four-line `Widget` struct each extension owns.
public func unitsWidgetConfiguration(host: WidgetHost, families: [WidgetFamily]) -> some WidgetConfiguration {
    StaticConfiguration(kind: UnitsWidget.kind, provider: UnitsTimelineProvider(host: host)) { entry in
        UnitsWidgetEntryView(
            context: WidgetRenderContext(snapshot: entry.snapshot, now: entry.date, host: host))
    }
    .configurationDisplayName(UnitsWidget.displayName)
    .description(UnitsWidget.description)
    .supportedFamilies(families)
}
