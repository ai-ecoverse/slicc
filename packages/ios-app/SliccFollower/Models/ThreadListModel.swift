import SliccTrayKit
import SwiftUI





@MainActor
final class ThreadListModel: ObservableObject {
    
    @Published var isOverlayOpen = false
    
    
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

    
    
    func didSelect(in presentation: ThreadListPresentation) {
        if presentation == .overlay { isOverlayOpen = false }
    }

    
    
    func presentationChanged(to presentation: ThreadListPresentation) {
        if presentation == .sidebar { isOverlayOpen = false }
    }

    
    
    func sync(scoops: [ScoopSummary], selectedJid: String?) {
        let counts = ledger.sync(scoops.map(ThreadUnreadLedger.Unit.init), selectedId: selectedJid)
        if counts != unread { unread = counts }
    }
}



private struct ThreadListPresentationKey: EnvironmentKey {
    static let defaultValue: ThreadListPresentation = .overlay
}

extension EnvironmentValues {
    
    
    var threadListPresentation: ThreadListPresentation {
        get { self[ThreadListPresentationKey.self] }
        set { self[ThreadListPresentationKey.self] = newValue }
    }
}
