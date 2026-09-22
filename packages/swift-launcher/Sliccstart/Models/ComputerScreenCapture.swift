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
        display: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, ComputerDisplayGeometry) -> Void,
        onEnded: (() -> Void)?
    ) async throws
    func stop()
}

enum ComputerCaptureError: Error, Equatable {
    case noDisplay
    case encodeFailed
    case displayOutOfRange(index: Int, available: String)
    case invalidDisplay(Double)

    var message: String {
        switch self {
        case .invalidDisplay(let value):
            return "display \(value) is not a valid display number"
        case .noDisplay:
            return "no display available for ScreenCaptureKit"
        case .encodeFailed:
            return "failed to encode a JPEG frame"
        case .displayOutOfRange(let index, let available):
            return "display \(index) is not attached — attached displays: \(available)"
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
        if let input = error as? ComputerInputError {
            return input.message
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
    private var onFrame: ((CGImage, ComputerDisplayGeometry) -> Void)?
    private var onEnded: (() -> Void)?
    private var geometry = ComputerDisplayGeometry.identity(size: .zero)
    private let sampleQueue = DispatchQueue(label: "com.slicc.sliccstart.computer-capture")

    @MainActor
    func start(
        fps: Double,
        maxWidth: Int?,
        display: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, ComputerDisplayGeometry) -> Void,
        onEnded: (() -> Void)?
    ) async throws {
        stop()
        self.onFrame = onFrame
        self.onEnded = onEnded
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let geometries = content.displays.map(Self.geometry(for:))
        let chosen = try ComputerDisplaySelection.pick(
            from: geometries, activeOrder: Self.activeDisplayIDs(), index: display)
        guard let scDisplay = content.displays.first(where: { $0.displayID == chosen.displayID })
        else { throw ComputerCaptureError.noDisplay }
        geometry = chosen
        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
        // Pixels, not `SCDisplay`'s points: `SCStreamConfiguration.width`/`.height`
        // are pixel counts, so feeding points downsamples a Retina display by its
        // backing scale and caps `--size` at the point width (#3380).
        let config = ComputerCaptureLayout.streamConfiguration(
            nativeWidth: Int(chosen.pixelSize.width.rounded()),
            nativeHeight: Int(chosen.pixelSize.height.rounded()),
            fps: fps, maxWidth: maxWidth)
        if !watch {
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
            onFrame(image, chosen)
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
            onFrame(image, self.geometry)
        }
    }

    /// `SCDisplay` reports points; pixels come from the display mode and the
    /// global origin from `CGDisplayBounds`, which is the space `CGEvent` uses.
    private static func geometry(for display: SCDisplay) -> ComputerDisplayGeometry {
        let points = CGSize(width: CGFloat(display.width), height: CGFloat(display.height))
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        let pixels = mode.map {
            CGSize(width: CGFloat($0.pixelWidth), height: CGFloat($0.pixelHeight))
        }
        let bounds = CGDisplayBounds(display.displayID)
        let origin = bounds.isNull || bounds.isEmpty ? display.frame.origin : bounds.origin
        return ComputerDisplayGeometry(
            displayID: display.displayID,
            origin: origin,
            pointSize: points,
            pixelSize: pixels,
            isMain: display.displayID == CGMainDisplayID())
    }

    /// The geometry input maps through when no frame of that display has been
    /// captured yet. CoreGraphics only, so it needs no Screen Recording grant.
    nonisolated static func liveGeometry(index: Int?) throws -> ComputerDisplayGeometry {
        let ids = activeDisplayIDs()
        let geometries = ids.map { id -> ComputerDisplayGeometry in
            let bounds = CGDisplayBounds(id)
            let pixels = CGDisplayCopyDisplayMode(id).map {
                CGSize(width: CGFloat($0.pixelWidth), height: CGFloat($0.pixelHeight))
            }
            return ComputerDisplayGeometry(
                displayID: id, origin: bounds.origin, pointSize: bounds.size,
                pixelSize: pixels, isMain: id == CGMainDisplayID())
        }
        return try ComputerDisplaySelection.pick(from: geometries, activeOrder: ids, index: index)
    }

    private nonisolated static func activeDisplayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
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
