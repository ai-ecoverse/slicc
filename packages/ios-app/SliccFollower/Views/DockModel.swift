import Foundation

/// A workbench surface the dock can open. Mirrors the web dock's item set
/// (`packages/webcomponents/src/dock/slicc-dock.ts`): sprinkle launchers
/// plus the pinned system tools, in prototype order.
enum DockSurface: Hashable {
    case sprinkle(name: String)
    case browser
    case files
    case term
    case memory
    case monitor
}

/// One rail entry. `id` doubles as the accessibility identifier suffix
/// (`dock-<id>`), mirroring the web items' `data-t` ids.
struct DockItem: Identifiable, Hashable {
    let id: String
    let surface: DockSurface
    let systemImage: String
    let label: String
}

/// Pure builders so the rail's order is unit-testable: sprinkle launchers
/// at the top; the pinned tools anchor the bottom after a spacer + divider
/// (the view owns those two).
///
/// There is no `New +` launcher: sprinkles are authored on the leader, so
/// the button could only ever open a placeholder — a rail entry that does
/// nothing costs a tap target and teaches the wrong affordance.
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

    /// The pinned system tools, in the web dock's exact order.
    static let toolItems: [DockItem] = [
        DockItem(id: "browser", surface: .browser, systemImage: "globe", label: "Browser"),
        DockItem(id: "files", surface: .files, systemImage: "folder", label: "Files"),
        DockItem(id: "term", surface: .term, systemImage: "terminal", label: "Terminal"),
        DockItem(id: "memory", surface: .memory, systemImage: "brain", label: "Memory"),
        DockItem(
            id: "monitor", surface: .monitor, systemImage: "waveform.path.ecg",
            label: "Monitor"),
    ]

    /// The follower-honest placeholder for surfaces the phone cannot serve,
    /// texts shared with the browser follower (`wc-follower.ts`) so both
    /// followers explain the constraint in the same words. Nil for surfaces
    /// that have a real view.
    static func placeholderText(for surface: DockSurface) -> String? {
        switch surface {
        case .sprinkle, .browser, .monitor, .memory, .files:
            return nil
        case .term:
            return "The shell runs on the leader. A follower has no local terminal - drive the session through chat."
        }
    }
}
