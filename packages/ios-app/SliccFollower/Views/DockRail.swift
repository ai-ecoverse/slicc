import SwiftUI

/// The 48pt right-edge dock rail — the phone's tab bar for workbench
/// surfaces, mirroring the webapp's narrow-viewport IA (`slicc-shell.ts`
/// ≤560px: chat is the app, the workbench overlays it, only the dock rail
/// stays tappable). A right rail rather than a bottom tab bar,
/// deliberately: it matches the web dock position (cross-float muscle
/// memory), and the bottom edge on iOS belongs to the composer and the
/// keyboard.
///
/// Interaction semantics preserved from the web dock: tapping an idle item
/// selects it; tapping the ACTIVE item collapses the workbench — a toggle,
/// not a nav stack. The freezer slots into the leading (top) edge, absorbed
/// from its pre-dock toolbar-only life (#1802 coordination note).
struct DockRail: View {
    @Binding var active: DockSurface?
    let sprinkles: [SprinkleSummary]
    /// Opens the Past Sessions sheet (the freezer keeps its sheet
    /// presentation — it is chat history, not a workbench surface).
    let onFreezer: () -> Void

    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 6) {
            // The dynamic section scrolls; the pinned tools below never
            // leave the screen. Seven fixed 36pt items already fill a
            // landscape rail — one leader sprinkle must not push the
            // terminal off the edge.
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 6) {
                    railButton(
                        id: "freezer", systemImage: "snowflake", label: "Past Sessions",
                        isActive: false, action: onFreezer)

                    ForEach(DockModel.sprinkleItems(sprinkles)) { item in
                        itemButton(item)
                    }
                }
            }

            Spacer(minLength: 8)

            Rectangle()
                .fill(palette.line)
                .frame(width: 24, height: 1)

            ForEach(DockModel.toolItems) { item in
                itemButton(item)
            }
        }
        .padding(.vertical, 10)
        .frame(width: 48)
        .frame(maxHeight: .infinity)
        .background(palette.surface)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(palette.line)
                .frame(width: 0.5)
        }
    }

    @ViewBuilder
    private func itemButton(_ item: DockItem) -> some View {
        railButton(
            id: item.id,
            systemImage: item.systemImage,
            label: item.label,
            isActive: active == item.surface
        ) {
            // Tap-active-to-collapse is what makes the dock feel like a
            // toggle instead of a nav stack (web dock parity).
            let next = active == item.surface ? nil : item.surface
            if reduceMotion {
                active = next
            } else {
                withAnimation(.easeInOut(duration: 0.2)) { active = next }
            }
        }
    }

    @ViewBuilder
    private func railButton(
        id: String, systemImage: String, label: String, isActive: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(isActive ? palette.accent : palette.ink.opacity(0.65))
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: 9)
                        .fill(isActive ? palette.accent.opacity(0.18) : .clear)
                )
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier("dock-\(id)")
    }
}
