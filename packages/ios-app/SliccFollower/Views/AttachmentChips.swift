import SliccTrayKit
import SwiftUI

/// Attachment chips shown above a user bubble.
///
/// Mirrors `slicc-user-message.ts`: an image with inline base64 renders as a
/// thumbnail, everything else falls back to a kind glyph, and the chip carries
/// only the filename beside it.
///
/// The webapp's chat path deliberately shows no size or MIME meta line — its
/// mapper (`toUserAttachment` in `wc-message-view.ts`) drops `mimeType`,
/// `size`, `path` and `error` before the component ever sees them, so a chip
/// there is a visual plus a name. This mirrors that rather than inventing a
/// richer treatment the browser follower does not have.
struct AttachmentChips: View {
    let attachments: [MessageAttachment]

    @Environment(\.palette) private var palette

    private var chipBackground: Color { palette.field }
    private var borderColor: Color { palette.ink.opacity(0.10) }

    var body: some View {
        // `flex-wrap: wrap` on the web. A horizontal scroller is the closest
        // native equivalent that never truncates a long attachment list.
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                ForEach(attachments) { attachment in
                    chip(attachment)
                }
            }
            .padding(.horizontal, 4)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func chip(_ attachment: MessageAttachment) -> some View {
        HStack(spacing: 6) {
            visual(attachment)
            Text(attachment.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(palette.ink.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(chipBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(borderColor, lineWidth: 0.5)
        )
        .frame(maxWidth: 240)
        .accessibilityIdentifier("attachment-\(attachment.id)")
    }

    @ViewBuilder
    private func visual(_ attachment: MessageAttachment) -> some View {
        if attachment.kind == .image, let image = decodedImage(attachment) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 30, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 7))
        } else {
            // Covers a `path`-only attachment too: the leader strips oversize
            // payloads to a VFS path, leaving no bytes to draw.
            Image(systemName: SliccIcons.attachment(attachment.kind))
                .font(.system(size: 16))
                .foregroundStyle(palette.ink.opacity(0.6))
                .frame(width: 30, height: 30)
        }
    }

    private func decodedImage(_ attachment: MessageAttachment) -> UIImage? {
        guard let data = attachment.data,
            let bytes = Data(base64Encoded: data)
        else { return nil }
        return UIImage(data: bytes)
    }
}

// MARK: - ErrorCard

/// A cone error, rendered as a card instead of an ordinary assistant bubble.
///
/// Mirrors `slicc-error-card.ts`: a red-tinted card with an uppercase
/// "Something went wrong" header over the raw error text.
///
/// The web card also offers a contextual action (`Try again`, `Open Settings`,
/// `Change model`, `Log in again`). Those are omitted here for the same reason
/// the follower's `tool_ui` card is read-only: every one of them acts on
/// leader-side state, the follower→leader protocol carries no equivalent
/// message, and a button that silently does nothing is worse than no button.
struct ErrorCard: View {
    let message: ChatMessage

    private let cardBackground = Color(red: 0x3A / 255, green: 0x14 / 255, blue: 0x18 / 255)
    private let borderColor = Color(red: 0xDC / 255, green: 0x26 / 255, blue: 0x26 / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                Text("Something went wrong".uppercased())
                    .font(.system(size: 10.5, weight: .semibold))
                    .kerning(0.2)
            }
            .foregroundStyle(Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255))

            Text(message.content)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.9))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(borderColor.opacity(0.4), lineWidth: 0.5)
        )
        .padding(.horizontal, 4)
        .accessibilityIdentifier("error-card")
    }
}
