import SwiftUI
import VisionKit

struct QRScannerView: UIViewControllerRepresentable {
    @Binding var scannedURL: String
    @Environment(\.dismiss) var dismiss

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        try? scanner.startScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: QRScannerView
        init(parent: QRScannerView) { self.parent = parent }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard case .barcode(let barcode) = addedItems.first,
                  let urlString = barcode.payloadStringValue,
                  urlString.hasPrefix("https://") else { return }
            parent.scannedURL = urlString
            parent.dismiss()
        }
    }
}

