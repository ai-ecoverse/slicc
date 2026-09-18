import SliccTrayKit
import SwiftUI




@MainActor
final class ChatPresentationState: ObservableObject {
    @Published var activeSurface: DockSurface?
    
    
    
    
    @Published var terminalWasOpened: Bool
    @Published var composerDraft: String
    
    
    
    
    @Published var stagedAttachments: [MessageAttachment] = []

    
    
    
    
    
    
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
