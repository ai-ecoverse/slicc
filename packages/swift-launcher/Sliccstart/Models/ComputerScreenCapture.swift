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
        onFrame: @escaping (CGImage, CGSize) -> Void,
        onEnded: (() -> Void)?
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

/// Maps capture/permission failures onto the `computer.native.error` string.
enum ComputerCaptureFailure {
    static func message(for error: Error) -> String {
        if let permission = error as? ComputerPermissionError {
            return permission.message
        }
        if let capture = error as? ComputerCaptureError {
            return capture.message
        }
        return String(describing: error)
    }
}

/// Pure ScreenCaptureKit geometry: fps clamp, maxWidth scale, stream config.
enum ComputerCaptureLayout {
    static let minFps: Double = 1
    static let maxFps: Double = 15

    static func clampFps(_ fps: Double) -> Double {
        max(minFps, min(fps, maxFps))
    }

    static func outputSize(nativeWidth: Int, nativeHeight: Int, maxWidth: Int?) -> (
        width: Int, height: Int
    ) {
        if let maxWidth, maxWidth > 0, maxWidth < nativeWidth {
            let scale = Double(maxWidth) / Double(nativeWidth)
            return (maxWidth, max(1, Int((Double(nativeHeight) * scale).rounded())))
        }
        return (nativeWidth, nativeHeight)
    }

    static func streamConfiguration(
        nativeWidth: Int, nativeHeight: Int, fps: Double, maxWidth: Int?
    ) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.capturesAudio = false
        let cappedFps = clampFps(fps)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(cappedFps))
        let size = outputSize(
            nativeWidth: nativeWidth, nativeHeight: nativeHeight, maxWidth: maxWidth)
        config.width = size.width
        config.height = size.height
        return config
    }
}

/// Live ScreenCaptureKit session. One-shot uses `SCScreenshotManager`; a
/// watch uses `SCStream` and honours `fps` / `maxWidth`.
@MainActor
final class ScreenCaptureKitCapturer: NSObject, ComputerCapturing, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var onFrame: ((CGImage, CGSize) -> Void)?
    private var onEnded: (() -> Void)?
    private var nativeSize = CGSize.zero
    private let sampleQueue = DispatchQueue(label: "com.slicc.sliccstart.computer-capture")

    @MainActor
    func start(
        fps: Double,
        maxWidth: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, CGSize) -> Void,
        onEnded: (() -> Void)?
    ) async throws {
        stop()
        self.onFrame = onFrame
        self.onEnded = onEnded
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw ComputerCaptureError.noDisplay }
        nativeSize = CGSize(width: display.width, height: display.height)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = ComputerCaptureLayout.streamConfiguration(
            nativeWidth: display.width, nativeHeight: display.height, fps: fps, maxWidth: maxWidth)
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
        onEnded = nil
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

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.onEnded?()
        }
    }

    private nonisolated static func cgImage(from sampleBuffer: CMSampleBuffer) -> CGImage? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        return CIContext().createCGImage(ciImage, from: ciImage.extent)
    }
}
