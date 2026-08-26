import SliccTrayKit
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
    /// Photos staged but not yet sent. Local `@State` in `InputBar` would be
    /// discarded along with the composer when the layout switches, and an
    /// in-flight `PhotosPicker` load would then complete into a view that is
    /// no longer on screen.
    @Published var stagedAttachments: [MessageAttachment] = []

    /// Keeping `terminalWasOpened` here only preserves the *decision* to show
    /// a terminal. The surface itself, its scrollback, and any in-flight
    /// command live in this model, and the adaptive switch replaces one shell
    /// subtree with the other wholesale — so a `@StateObject` inside either
    /// shell would be rebuilt from scratch on a rotation or Split View resize.
    /// Ownership sits here instead, and `TerminalView` merely observes it.
    private var terminalModel: TerminalViewModel?

    init(
        activeSurface: DockSurface? = nil,
        terminalWasOpened: Bool = false,
        composerDraft: String = ""
    ) {
        self.activeSurface = activeSurface
        self.terminalWasOpened = terminalWasOpened
        self.composerDraft = composerDraft
    }

    /// Built on first use because the client only becomes reachable once the
    /// shell has an `AppState` in its environment. `terminalModel` is not
    /// `@Published`, so memoizing it while a body is evaluating cannot start
    /// another render pass.
    func terminal(client: TerminalClient) -> TerminalViewModel {
        if let terminalModel { return terminalModel }
        #if DEBUG
            let model = TerminalViewModel(
                client: client, fixtureEnabled: UITestHooks.terminalFixtureEnabled)
        #else
            let model = TerminalViewModel(client: client)
        #endif
        terminalModel = model
        return model
    }
}
