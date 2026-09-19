import SwiftUI

/// The floating chrome of the conversation — the composer and the nav-bar
/// pills — is Liquid Glass over the transcript, not an opaque band beside it.
///
/// One modifier so the two edges cannot drift apart. `interactive` is for
/// things you press (buttons); a text field stays still under the finger.
extension View {
    func floatingGlass(in shape: some Shape, interactive: Bool = false) -> some View {
        glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }
}
