import Foundation

// MARK: - Scoop swipe navigation
//
// Lives outside the `AppState` body, which sits against the SwiftLint
// `file_length` ceiling; the swipe arbitration itself is in the views.

extension AppState {
    /// Swipe left → next scoop in the list. Wraps around to the first when at end.
    func swipeToNextScoop() {
        guard !scoops.isEmpty else { return }
        let currentIndex = scoops.firstIndex(where: { $0.jid == selectedScoopJid }) ?? 0
        let nextIndex = (currentIndex + 1) % scoops.count
        selectScoop(jid: scoops[nextIndex].jid)
    }

    /// Swipe right → previous scoop. Falls back to the cone if we'd otherwise
    /// underflow (matches the user's "or cone if no more are left" expectation).
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
