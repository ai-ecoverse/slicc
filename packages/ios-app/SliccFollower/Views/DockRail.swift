import SliccTrayKit
import SwiftUI














struct DockRail: View {
    @Binding var active: DockSurface?
    let sprinkles: [SprinkleSummary]

    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 6) {
            
            
            
            
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 6) {
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
