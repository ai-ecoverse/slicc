import SliccTrayKit
import SwiftUI

struct RemoteTabCard: View {
    let target: TrayTargetEntry

    var onOpen: (() -> Void)?

    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    private enum PreviewState: Equatable {
        case loading
        case image(UIImage)
        case unavailable(String)
    }

    @State private var preview: PreviewState = .loading

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
        .accessibilityAction(named: "Open here") { onOpen?() }
        .task(id: target.targetId) { await capture() }
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            Rectangle().fill(palette.field)
            switch preview {
            case .loading:
                ProgressView()
            case .image(let image):

                Color.clear
                    .overlay(
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .accessibilityIdentifier("remote-preview-\(target.targetId)")
                    )
                    .clipped()
            case .unavailable(let reason):
                VStack(spacing: 6) {
                    Image(systemName: "rectangle.on.rectangle.slash")
                        .foregroundStyle(palette.inkTertiary)
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(palette.inkSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)
                }

                .padding(.bottom, 48)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(target.title.isEmpty ? "Untitled tab" : target.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            HStack(spacing: 5) {
                Text(target.runtimeId == "leader" ? "leader" : target.runtimeId)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
                    .foregroundStyle(.secondary)
                Text(Self.displayHost(target.url))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial)
    }

    static func displayHost(_ url: String) -> String {
        guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    private func capture() async {
        #if DEBUG
            if let canned = UITestHooks.remotePreviewFixtureImage() {
                preview = .image(canned)
                return
            }
        #endif
        guard target.runtimeId == "leader" else {

            preview = .unavailable("Live on \(target.runtimeId) — no preview path yet")
            return
        }
        do {
            let image = try await appState.cdpPreviews.capturePreview(
                targetId: target.localTargetId)
            preview = .image(image)
        } catch {
            preview = .unavailable(error.localizedDescription)
        }
    }
}
