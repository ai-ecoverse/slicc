import Foundation
import SliccTrayKit




enum DockSurface: Hashable {
    case sprinkle(name: String)
    case browser
    case files
    case term
    case memory
    case monitor
}



struct DockItem: Identifiable, Hashable {
    let id: String
    let surface: DockSurface
    let systemImage: String
    let label: String
}








enum DockModel {
    static func sprinkleItems(_ sprinkles: [SprinkleSummary]) -> [DockItem] {
        sprinkles.map { sprinkle in
            DockItem(
                id: "sprinkle-\(sprinkle.name)",
                surface: .sprinkle(name: sprinkle.name),
                systemImage: SliccIcons.sprinkle(iconSpec: sprinkle.icon),
                label: sprinkle.title
            )
        }
    }

    
    static let toolItems: [DockItem] = [
        DockItem(id: "browser", surface: .browser, systemImage: "globe", label: "Browser"),
        DockItem(id: "files", surface: .files, systemImage: "folder", label: "Files"),
        DockItem(id: "term", surface: .term, systemImage: "terminal", label: "Terminal"),
        DockItem(id: "memory", surface: .memory, systemImage: "brain", label: "Memory"),
        DockItem(
            id: "monitor", surface: .monitor, systemImage: "waveform.path.ecg",
            label: "Monitor"),
    ]
}
