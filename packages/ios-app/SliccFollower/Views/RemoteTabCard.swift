import SwiftUI

/// One remote tray tab (leader or another follower) as a preview card:
/// title, host, and a screenshot captured over follower-originated CDP.
/// Leader tabs preview via its browser transport; a target whose runtime
/// cannot serve a capture shows the reason instead of an empty frame.
struct RemoteTabCard: View {
    let target: TrayTargetEntry

    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    private enum PreviewState: Equatable {
        case loading
        case image(UIImage)
        case unavailable(String)
    }

    @State private var preview: PreviewState = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(palette.field)
                switch preview {
                case .loading:
                    ProgressView()
                case .image(let image):
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityIdentifier("remote-preview-\(target.targetId)")
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
                }
            }
            .frame(height: 140)

            VStack(alignment: .leading, spacing: 2) {
                Text(target.title.isEmpty ? "Untitled tab" : target.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(target.runtimeId == "leader" ? "leader" : target.runtimeId)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(palette.accent.opacity(0.15))
                        .foregroundStyle(palette.accent)
                        .clipShape(Capsule())
                    Text(target.url)
                        .font(.caption2)
                        .foregroundStyle(palette.inkSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(10)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .task(id: target.targetId) { await capture() }
    }

    private func capture() async {
        #if DEBUG
            if let canned = UITestHooks.remotePreviewFixtureImage() {
                preview = .image(canned)
                return
            }
        #endif
        guard target.runtimeId == "leader" else {
            // Other-follower captures would round-trip through that
            // follower's own CDP host; not wired yet — say so honestly.
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
