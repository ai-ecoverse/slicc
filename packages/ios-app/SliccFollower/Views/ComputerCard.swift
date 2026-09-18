import SliccTrayKit
import SwiftUI




struct ComputerCard: View {
    let computer: ComputerDescriptor
    @ObservedObject var frame: ComputerLiveFrame
    var onOpen: (() -> Void)?

    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .bottom) {
            thumbnail
            caption
        }
        .frame(height: 156)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(palette.line, lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { onOpen?() }
        .accessibilityIdentifier("computer-card-\(computer.id)")
        .accessibilityAction(named: "Open live view") { onOpen?() }
        .onAppear { appState.startWatchingComputer(computer.id) }
        .onDisappear { appState.stopWatchingComputer(computer.id) }
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            Rectangle().fill(palette.field)
            if let image = frame.image {
                Color.clear
                    .overlay(
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .accessibilityIdentifier("computer-preview-\(computer.id)")
                    )
                    .clipped()
            } else {
                ProgressView()
                    .accessibilityIdentifier("computer-preview-loading-\(computer.id)")
            }
        }
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(computer.title.isEmpty ? computer.id : computer.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            HStack(spacing: 5) {
                Text(computer.kind)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
                    .foregroundStyle(.secondary)
                Text(computer.state)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial)
    }
}
