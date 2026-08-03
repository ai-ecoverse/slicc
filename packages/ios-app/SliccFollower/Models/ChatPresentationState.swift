import SwiftUI

/// View-only state that must outlive either adaptive shell subtree.
/// `ChatView` owns one instance and passes bindings into both layouts, so a
/// compact/regular transition cannot reset the user's place.
@MainActor
final class ChatPresentationState: ObservableObject {
    @Published var activeSurface: DockSurface?
    /// Once opened, keep Ghostty attached to the window behind other tabs so
    /// removing its UIView cannot destroy the terminal surface and scrollback.
    /// It lives here rather than in either shell because a rotation or Split
    /// View resize would otherwise take the surface down with the subtree.
    @Published var terminalWasOpened: Bool
    @Published var composerDraft: String
    @Published var transcriptPosition: ScrollPosition

    init(
        activeSurface: DockSurface? = nil,
        terminalWasOpened: Bool = false,
        composerDraft: String = ""
    ) {
        self.activeSurface = activeSurface
        self.terminalWasOpened = terminalWasOpened
        self.composerDraft = composerDraft
        transcriptPosition = ScrollPosition(idType: String.self, edge: .bottom)
    }
}
