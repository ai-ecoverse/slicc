import SliccTrayKit
import SwiftUI




struct ComputerLiveView: View {
    let computer: ComputerDescriptor

    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette
    @ObservedObject var frame: ComputerLiveFrame

    var body: some View {
        ZStack(alignment: .bottom) {
            liveImage
            chrome
        }
        .background(palette.canvas)
        .onAppear { appState.startWatchingComputer(computer.id) }
        .onDisappear { appState.stopWatchingComputer(computer.id) }
        .accessibilityIdentifier("computer-live-\(computer.id)")
    }

    @ViewBuilder
    private var liveImage: some View {
        if let image = frame.image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("computer-live-image-\(computer.id)")
        } else {
            ProgressView("Waiting for frame")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var chrome: some View {
        VStack(spacing: 10) {
            if let keys = computer.softKeys, !keys.isEmpty {
                HStack(spacing: 8) {
                    ForEach(keys, id: \.keysym) { key in
                        Button(key.label) {
                            appState.sendComputerSoftKey(id: computer.id, keysym: key.keysym)
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.regularMaterial, in: Capsule())
                        .accessibilityIdentifier("computer-softkey-\(key.keysym)")
                    }
                }
            }
            HStack(spacing: 10) {
                Text(computer.title.isEmpty ? computer.id : computer.title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(.regularMaterial, in: Capsule())
                Button {
                    appState.viewingComputerId = nil
                } label: {
                    Image(systemName: "square.on.square")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                }
                .background(.regularMaterial, in: Circle())
                .accessibilityLabel("Show all computers")
                .accessibilityIdentifier("computer-show-all")
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }
}
