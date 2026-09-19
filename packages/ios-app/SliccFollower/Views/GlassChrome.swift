import SwiftUI






extension View {
    func floatingGlass(in shape: some Shape, interactive: Bool = false) -> some View {
        glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }
}
