import PhotosUI
import SliccTrayKit
import SwiftUI
import UIKit

// MARK: - Staged chips

/// The row of photos staged in the composer, shown above the input field
/// until send. Same chip language as `AttachmentChips` (the sent-message
/// rendering) plus a remove button — staging is the one place an
/// attachment is still editable.
struct StagedAttachmentsRow: View {
    let attachments: [MessageAttachment]
    let onRemove: (MessageAttachment) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { attachment in
                    chip(attachment)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
        // No container identifier: SwiftUI stamps one onto every leaf,
        // clobbering the per-chip remove-button ids tests key on (the
        // repo's put-ids-on-leaves gotcha). Presence is asserted via the
        // `staged-remove-*` leaves.
    }

    private func chip(_ attachment: MessageAttachment) -> some View {
        HStack(spacing: 6) {
            if attachment.kind == .image, let image = thumbnail(attachment) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
            } else {
                Image(systemName: attachment.error == nil ? "photo" : "exclamationmark.triangle")
                    .font(.system(size: 15))
                    .foregroundStyle(
                        attachment.error == nil ? palette.inkSecondary : .red
                    )
                    .frame(width: 30, height: 30)
            }
            Text(attachment.error ?? attachment.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(
                    attachment.error == nil ? palette.ink.opacity(0.85) : .red
                )
                .lineLimit(1)
                .truncationMode(.middle)
            Button {
                onRemove(attachment)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(palette.inkTertiary)
            }
            .accessibilityIdentifier("staged-remove-\(attachment.id)")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(palette.field)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .frame(maxWidth: 260)
    }

    private func thumbnail(_ attachment: MessageAttachment) -> UIImage? {
        guard let data = attachment.data, let bytes = Data(base64Encoded: data) else {
            return nil
        }
        return UIImage(data: bytes)
    }
}

// MARK: - Camera

/// Live camera capture for the composer. `UIImagePickerController` rather
/// than a custom `AVCaptureSession` — one photo into the composer needs the
/// system capture UI, not a viewfinder of our own (the issue offers exactly
/// this trade). The caller must gate on
/// `UIImagePickerController.isSourceTypeAvailable(.camera)`: simulators and
/// camera-restricted devices have none, and the option should disappear
/// rather than fail.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate
    {
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            } else {
                onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
