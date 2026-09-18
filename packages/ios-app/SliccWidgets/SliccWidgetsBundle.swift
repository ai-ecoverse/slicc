import SliccWidgetKit
import SwiftUI
import WidgetKit









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
