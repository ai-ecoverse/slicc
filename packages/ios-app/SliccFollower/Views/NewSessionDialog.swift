import SwiftUI

/// The `new_session` disposition dialog (#1799), shared by every entry
/// point — the Past Sessions sheet's `New +` and the chat's top-control
/// New chat button — so the save/skip/erase contract and the erase
/// double-confirm stay single-sourced.
struct NewSessionDialog: ViewModifier {
    @Binding var isPresented: Bool
    @EnvironmentObject var appState: AppState
    /// Runs after a disposition is chosen (the sheet entry point uses it
    /// to dismiss itself; the chat entry point needs nothing).
    var onRequested: () -> Void = {}

    @State private var confirmErase = false

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Start a new chat?", isPresented: $isPresented, titleVisibility: .visible
            ) {
                Button("Save & start new") {
                    appState.requestNewSession(.save)
                    onRequested()
                }
                Button("New chat — skip memory") {
                    appState.requestNewSession(.skip)
                    onRequested()
                }
                Button("Erase & start new", role: .destructive) {
                    // Irreversible — double-confirm rather than firing off a
                    // destructive action from a slippable dialog.
                    confirmErase = true
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The current session is archived on the leader; Save also extracts memory.")
            }
            .alert("Erase the current session?", isPresented: $confirmErase) {
                Button("Erase", role: .destructive) {
                    appState.requestNewSession(.erase)
                    onRequested()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This discards the current chat permanently — nothing is archived.")
            }
    }
}
