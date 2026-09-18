import CoreGraphics
import Foundation
import SliccTrayFollower

@testable import Sliccstart

extension ComputerPermissionProbe {
    static let alwaysGranted = ComputerPermissionProbe(
        screenRecordingGranted: { true },
        requestScreenRecording: { true },
        accessibilityGranted: { true },
        requestAccessibility: { true }
    )

    static let alwaysDenied = ComputerPermissionProbe(
        screenRecordingGranted: { false },
        requestScreenRecording: { false },
        accessibilityGranted: { false },
        requestAccessibility: { false }
    )
}

final class RecordingEventSink: ComputerEventSink {
    private(set) var actions: [ComputerCGAction] = []
    func post(_ action: ComputerCGAction) { actions.append(action) }
}

@MainActor
final class StubCapturer: ComputerCapturing {
    var image: CGImage
    var native: CGSize
    private(set) var started = 0
    private(set) var stopped = 0
    private(set) var lastFps: Double?
    private(set) var lastMaxWidth: Int?
    private(set) var lastWatch: Bool?
    var startError: Error?

    init(image: CGImage = ComputerTestImages.solid(width: 64, height: 48), native: CGSize? = nil) {
        self.image = image
        self.native = native ?? CGSize(width: image.width, height: image.height)
    }

    func start(
        fps: Double,
        maxWidth: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, CGSize) -> Void
    ) async throws {
        started += 1
        lastFps = fps
        lastMaxWidth = maxWidth
        lastWatch = watch
        if let startError { throw startError }
        onFrame(image, native)
    }

    func stop() { stopped += 1 }
}

enum ComputerTestImages {
    static func solid(width: Int, height: Int, red: CGFloat = 1, green: CGFloat = 0, blue: CGFloat = 0)
        -> CGImage
    {
        let space = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: red, green: green, blue: blue, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }
}

@MainActor
final class RecordingConnector: TrayFollowerConnecting {
    weak var delegate: TrayFollowerConnectorDelegate?
    private(set) var started = 0
    private(set) var stopped = 0
    var startError: Error?

    func start() async throws {
        started += 1
        if let startError { throw startError }
    }

    func stop() { stopped += 1 }
}
