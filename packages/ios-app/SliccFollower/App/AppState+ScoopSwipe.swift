import Foundation






extension AppState {
    
    func swipeToNextScoop() {
        guard !scoops.isEmpty else { return }
        let currentIndex = scoops.firstIndex(where: { $0.jid == selectedScoopJid }) ?? 0
        let nextIndex = (currentIndex + 1) % scoops.count
        selectScoop(jid: scoops[nextIndex].jid)
    }

    
    
    func swipeToPreviousScoop() {
        guard !scoops.isEmpty else { return }
        let currentIndex = scoops.firstIndex(where: { $0.jid == selectedScoopJid }) ?? 0
        if currentIndex > 0 {
            selectScoop(jid: scoops[currentIndex - 1].jid)
        } else if let cone = scoops.first(where: { $0.isRootUnit }) {
            selectScoop(jid: cone.jid)
        }
    }
}
