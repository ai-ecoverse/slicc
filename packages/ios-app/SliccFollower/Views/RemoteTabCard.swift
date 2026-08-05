import SliccTrayKit
import SwiftUI

/// One remote tray tab (leader or another follower) as a preview card:
/// title, host, and a screenshot captured over follower-originated CDP.
/// Leader tabs preview via its browser transport; a target whose runtime
/// cannot serve a capture shows the reason instead of an empty frame.
struct RemoteTabCard: View {
    let target: TrayTargetEntry
    /// Overview tap: open this tab's URL in a local tab. Attached inside
    /// the card body — a gesture bolted on from the grid outside never
    /// fired (the local card's inside-the-body gesture demonstrably does).
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
            // A material bar, not a gradient scrim. A translucent scrim's
            // contrast is whatever the page underneath happens to be, and a
            // screenshot of a light page swallowed the caption entirely.
            // Material stays legible over any backdrop and still shows the
            // shot through it.
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
                // Bounded via overlay: a bare `.fill` image reports its
                // oversized ideal height, inflating the ZStack past the
                // card frame — which pushed the bottom-anchored caption
                // half outside the clip shape and cut the text in two.
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
                // Clear of the caption bar, so the reason stays readable.
                .padding(.bottom, 48)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    /// Title + origin only. The full URL was the noisiest thing on the card
    /// and never fit; the host is what identifies a tab at a glance.
    ///
    /// `.primary` / `.secondary` over material are vibrant styles — the
    /// system keeps them legible against whatever the blurred screenshot
    /// behind them looks like, which a hand-picked white never could.
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
