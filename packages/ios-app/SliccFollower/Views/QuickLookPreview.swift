import QuickLook
import SwiftUI
import UIKit

// MARK: - QuickLookPreview

/// `QLPreviewController`, embedded as the body of a preview sheet.
///
/// The follower previews whatever the leader hands it — a screenshot, a PDF
/// report, a captured video, a keynote, an archive — and hand-rolling a
/// renderer per family is not a race worth entering. Quick Look already knows
/// them, and knows them better: pinch-zoom and pan on an image, page
/// navigation and text selection in a PDF, transport controls on media,
/// printing, and the system's own share sheet.
///
/// Embedded as a **child**, not presented: the sheet around it keeps its
/// title, Done button and Share item, so a file opened from a transcript
/// mention looks like one opened from the Files surface and neither grows a
/// second navigation bar. That is also why the controller is not wrapped in a
/// `UINavigationController` — it would bring one.
///
/// Only reached when `QuickLookPreview.canPreview` says Quick Look recognises
/// the file. Everything it refuses (a `.jsh`, a `.runbook`, an extensionless
/// blob — exactly the files the VFS is full of) falls back to the sheet's own
/// monospace text rendering, which is the better answer for source anyway:
/// it is themed, and it is selectable.
struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    /// Whether Quick Look can render this file.
    ///
    /// Asked of a real URL rather than a MIME type, because Quick Look
    /// resolves the type from the file itself — which is the whole reason the
    /// payload chips synthesise a name with an extension (`payload.png`)
    /// rather than handing over anonymous bytes.
    static func canPreview(_ url: URL) -> Bool {
        QLPreviewController.canPreview(url as QLPreviewItem)
    }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        controller.view.backgroundColor = .clear
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        controller.reloadData()
    }

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
            -> QLPreviewItem
        {
            url as QLPreviewItem
        }
    }
}
