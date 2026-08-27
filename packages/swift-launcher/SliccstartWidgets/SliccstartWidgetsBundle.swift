import SliccWidgetKit
import SwiftUI
import WidgetKit

/// Sliccstart's widget extension — Notification Centre and the macOS desktop.
///
/// The iOS twin is `packages/ios-app/SliccWidgets`; both are deliberately this
/// thin, with every pixel coming from `packages/swift-widgetkit`. The two
/// differences are the app group it reads (Sliccstart's, not the follower's)
/// and the family set: macOS has no lock screen, so no accessory families.
@main
struct SliccstartWidgetsBundle: WidgetBundle {
    var body: some Widget {
        SliccUnitsWidget()
    }
}

struct SliccUnitsWidget: Widget {
    var body: some WidgetConfiguration {
        unitsWidgetConfiguration(host: .sliccstart, families: UnitsWidget.macFamilies)
    }
}
