import SliccWidgetKit
import SwiftUI
import WidgetKit

/// The follower's widget extension.
///
/// Everything it draws lives in `packages/swift-widgetkit` — this target is
/// only the four lines WidgetKit insists on owning (`@main`, a bundle, a
/// `Widget` with an `init()`), plus the host binding that says which app group
/// to read and where a tap goes. Keep it that way: a widget extension is a
/// separate process with its own memory budget, and anything that compiles in
/// here is something the phone loads to draw a 158pt tile.
@main
struct SliccWidgetsBundle: WidgetBundle {
    var body: some Widget {
        SliccUnitsWidget()
    }
}

struct SliccUnitsWidget: Widget {
    var body: some WidgetConfiguration {
        unitsWidgetConfiguration(host: .follower, families: UnitsWidget.iOSFamilies)
    }
}
