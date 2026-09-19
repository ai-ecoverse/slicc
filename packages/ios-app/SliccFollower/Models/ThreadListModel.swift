import SliccTrayKit
import SwiftUI

/// View state of the thread list, owned by `ChatView` so it survives the
/// compact/regular swap (a rotation or a Split View resize replaces one shell
/// subtree with the other). Deliberately not on `AppState`: nothing here is
/// follower state, and `AppState` sits at its file-length ceiling.
@MainActor
final class ThreadListModel: ObservableObject {
    /// The slide-over is showing. Only meaningful in `.overlay`.
    @Published var isOverlayOpen = false
    /// The user folded the sidebar away. Only meaningful in `.sidebar`; not
    /// persisted, so every launch starts with the column open.
    @Published var isSidebarCollapsed = false
    @Published private(set) var unread: [String: Int] = [:]

    private var ledger = ThreadUnreadLedger()

    func isVisible(in presentation: ThreadListPresentation) -> Bool {
        switch presentation {
        case .overlay: isOverlayOpen
        case .sidebar: !isSidebarCollapsed
        }
    }

    func toggle(in presentation: ThreadListPresentation) {
        switch presentation {
        case .overlay: isOverlayOpen.toggle()
        case .sidebar: isSidebarCollapsed.toggle()
        }
    }

    func dismiss(in presentation: ThreadListPresentation) {
        switch presentation {
        case .overlay: isOverlayOpen = false
        case .sidebar: isSidebarCollapsed = true
        }
    }

    /// A pick closes the slide-over — it was covering the conversation you
    /// just asked for — and leaves a sidebar where it is.
    func didSelect(in presentation: ThreadListPresentation) {
        if presentation == .overlay { isOverlayOpen = false }
    }

    /// Crossing into the other shape drops a slide-over left open, so it does
    /// not spring back the next time the window narrows.
    func presentationChanged(to presentation: ThreadListPresentation) {
        if presentation == .sidebar { isOverlayOpen = false }
    }

    /// Fold a roster push or a selection change into the unread counts.
    /// Publishes only on change: this runs on every `scoops.list`.
    func sync(scoops: [ScoopSummary], selectedJid: String?) {
        let counts = ledger.sync(scoops.map(ThreadUnreadLedger.Unit.init), selectedId: selectedJid)
        if counts != unread { unread = counts }
    }
}

// MARK: - Environment

private struct ThreadListPresentationKey: EnvironmentKey {
    static let defaultValue: ThreadListPresentation = .overlay
}

extension EnvironmentValues {
    /// The shape the shell gave the thread list, so the switcher pill in the
    /// navigation bar toggles the right one.
    var threadListPresentation: ThreadListPresentation {
        get { self[ThreadListPresentationKey.self] }
        set { self[ThreadListPresentationKey.self] = newValue }
    }
}
