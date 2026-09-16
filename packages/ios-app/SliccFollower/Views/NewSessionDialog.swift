import SwiftUI

struct NewSessionDialog: ViewModifier {
    @Binding var isPresented: Bool
    @EnvironmentObject var appState: AppState

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

                    confirmErase = true
                }
                Button("Cancel") { isPresented = false }
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
