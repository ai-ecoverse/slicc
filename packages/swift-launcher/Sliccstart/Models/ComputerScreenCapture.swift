import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// Injectable capture so tests never start an `SCStream`.
@MainActor
protocol ComputerCapturing: AnyObject {
    func start(
        fps: Double,
        maxWidth: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, CGSize) -> Void
    ) async throws
    func stop()
}

enum ComputerCaptureError: Error, Equatable {
    case noDisplay
    case encodeFailed

    var message: String {
        switch self {
        case .noDisplay:
            return "no display available for ScreenCaptureKit"
        case .encodeFailed:
            return "failed to encode a JPEG frame"
        }
    }
}

/// Live ScreenCaptureKit session. One-shot uses `SCScreenshotManager`; a
/// watch uses `SCStream` and honours `fps` / `maxWidth`.
@MainActor
final class ScreenCaptureKitCapturer: NSObject, ComputerCapturing, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var onFrame: ((CGImage, CGSize) -> Void)?
    private var nativeSize = CGSize.zero
    private let sampleQueue = DispatchQueue(label: "com.slicc.sliccstart.computer-capture")

    @MainActor
    func start(
        fps: Double,
        maxWidth: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, CGSize) -> Void
    ) async throws {
        stop()
        self.onFrame = onFrame
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw ComputerCaptureError.noDisplay }
        nativeSize = CGSize(width: display.width, height: display.height)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = configuration(display: display, fps: fps, maxWidth: maxWidth)
        if !watch {
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
            onFrame(image, nativeSize)
            return
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    @MainActor
    func stop() {
        let current = stream
        stream = nil
        onFrame = nil
        guard let current else { return }
        Task { try? await current.stopCapture() }
    }

    nonisolated func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, let image = Self.cgImage(from: sampleBuffer) else { return }
        Task { @MainActor [weak self] in
            guard let self, let onFrame = self.onFrame else { return }
            onFrame(image, self.nativeSize)
        }
    }

    private func configuration(display: SCDisplay, fps: Double, maxWidth: Int?)
        -> SCStreamConfiguration
    {
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.capturesAudio = false
        let cappedFps = max(1, min(fps, 15))
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(cappedFps))
        let nativeW = display.width
        let nativeH = display.height
        if let maxWidth, maxWidth > 0, maxWidth < nativeW {
            let scale = Double(maxWidth) / Double(nativeW)
            config.width = maxWidth
            config.height = max(1, Int((Double(nativeH) * scale).rounded()))
        } else {
            config.width = nativeW
            config.height = nativeH
        }
        return config
    }

    private nonisolated static func cgImage(from sampleBuffer: CMSampleBuffer) -> CGImage? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        return CIContext().createCGImage(ciImage, from: ciImage.extent)
    }
}
