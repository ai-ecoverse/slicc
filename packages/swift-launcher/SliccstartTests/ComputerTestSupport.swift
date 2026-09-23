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

    
    
    static let captureOnly = ComputerPermissionProbe(
        screenRecordingGranted: { true },
        requestScreenRecording: { true },
        accessibilityGranted: { false },
        requestAccessibility: { false }
    )
}






final class MutableGrantProbe: @unchecked Sendable {
    var screenRecording: Bool
    var accessibility: Bool

    init(screenRecording: Bool, accessibility: Bool) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
    }

    var probe: ComputerPermissionProbe {
        ComputerPermissionProbe(
            screenRecordingGranted: { [self] in screenRecording },
            requestScreenRecording: { [self] in screenRecording },
            accessibilityGranted: { [self] in accessibility },
            requestAccessibility: { [self] in accessibility }
        )
    }
}






func scriptedGrantTick(_ beats: [@Sendable () async -> Void]) -> ComputerGrantTick {
    final class Cursor: @unchecked Sendable {
        var index = 0
    }
    let cursor = Cursor()
    return {
        guard cursor.index < beats.count else { return false }
        let beat = beats[cursor.index]
        cursor.index += 1
        await beat()
        return true
    }
}






final class StopBox: @unchecked Sendable {
    var stop: (@MainActor () -> Void)?

    func callStop() async {
        await MainActor.run { stop?() }
    }
}

final class RecordingEventSink: ComputerEventSink {
    private(set) var actions: [ComputerCGAction] = []
    var cursor: CGPoint?
    func post(_ action: ComputerCGAction) { actions.append(action) }
    func cursorLocation() -> CGPoint? { cursor }
}

@MainActor
class StubCapturer: ComputerCapturing {
    var image: CGImage
    
    
    var geometry: ComputerDisplayGeometry
    private(set) var started = 0
    private(set) var stopped = 0
    private(set) var lastFps: Double?
    private(set) var lastMaxWidth: Int?
    private(set) var lastDisplay: Int?
    private(set) var lastWatch: Bool?
    var startError: Error?
    var holdFrame = false
    var endsRemaining = 0
    private var pendingFrame: (() -> Void)?

    init(
        image: CGImage = ComputerTestImages.solid(width: 64, height: 48),
        native: CGSize? = nil,
        geometry: ComputerDisplayGeometry? = nil
    ) {
        self.image = image
        self.geometry =
            geometry
            ?? .identity(size: native ?? CGSize(width: image.width, height: image.height))
    }

    var native: CGSize { geometry.pixelSize }

    func start(
        fps: Double,
        maxWidth: Int?,
        display: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, ComputerDisplayGeometry) -> Void,
        onEnded: (() -> Void)?
    ) async throws {
        started += 1
        lastFps = fps
        lastMaxWidth = maxWidth
        lastDisplay = display
        lastWatch = watch
        if let startError { throw startError }
        if holdFrame {
            pendingFrame = { [image, geometry] in onFrame(image, geometry) }
        } else {
            onFrame(image, geometry)
        }
        if endsRemaining > 0 {
            endsRemaining -= 1
            let ended = onEnded
            Task { @MainActor in ended?() }
        }
    }

    func emitHeldFrame() { pendingFrame?() }

    func stop() { stopped += 1 }
}



@MainActor
final class MultiDisplayStubCapturer: StubCapturer {
    private let geometries: [Int: ComputerDisplayGeometry]
    private var again: (() -> Void)?
    
    
    var suspends = false
    private var parked: CheckedContinuation<Void, Never>?

    init(geometries: [Int: ComputerDisplayGeometry]) {
        self.geometries = geometries
        super.init()
    }

    override func start(
        fps: Double,
        maxWidth: Int?,
        display: Int?,
        watch: Bool,
        onFrame: @escaping (CGImage, ComputerDisplayGeometry) -> Void,
        onEnded: (() -> Void)?
    ) async throws {
        if let chosen = geometries[display ?? 0] { geometry = chosen }
        if suspends { await withCheckedContinuation { parked = $0 } }
        again = { [image, geometry] in onFrame(image, geometry) }
        try await super.start(
            fps: fps, maxWidth: maxWidth, display: display, watch: watch, onFrame: onFrame,
            onEnded: onEnded)
    }

    func emitAgain() { again?() }

    func release() {
        parked?.resume()
        parked = nil
    }
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
