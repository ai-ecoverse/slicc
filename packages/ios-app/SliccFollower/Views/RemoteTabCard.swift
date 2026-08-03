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
        ZStack(alignment: .bottomLeading) {
            thumbnail
            // A scrim, not a caption bar: the label reads over the darkest
            // part of the shot instead of stealing a strip of it, and the
            // gradient guarantees contrast whatever the page looks like.
            LinearGradient(
                colors: [.black.opacity(0), .black.opacity(0.55), .black.opacity(0.82)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 72)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .allowsHitTesting(false)
            caption
        }
        .frame(height: 156)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(palette.line, lineWidth: 0.5)
        )
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
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
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
                // Above the scrim's darkest band, so the reason stays legible.
                .padding(.bottom, 56)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    /// Title + origin only. The full URL was the noisiest thing on the card
    /// and never fit; the host is what identifies a tab at a glance.
    private var caption: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(target.title.isEmpty ? "Untitled tab" : target.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            HStack(spacing: 5) {
                Text(target.runtimeId == "leader" ? "leader" : target.runtimeId)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.white.opacity(0.22))
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                Text(Self.displayHost(target.url))
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 9)
    }

    /// Host without the `www.` noise; falls back to the raw string for
    /// `about:blank` and friends, which have no host at all.
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
