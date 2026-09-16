import SliccWidgetKit
import SwiftUI
import WidgetKit

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
