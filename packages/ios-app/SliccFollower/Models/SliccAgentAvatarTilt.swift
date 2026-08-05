import Combine
import CoreMotion
import Foundation
import UIKit

struct SliccAgentAvatarAttitude: Equatable, Sendable {
    static let zero = Self(roll: 0, pitch: 0)

    let roll: Double
    let pitch: Double
}

private struct SliccAgentAvatarTiltBaseline {
    static let defaultWindowDuration: TimeInterval = 60

    private struct Sample {
        let attitude: SliccAgentAvatarAttitude
        let timestamp: TimeInterval
    }

    private let windowDuration: TimeInterval
    private var samples: [Sample] = []
    private var firstSampleIndex = 0
    private var rollSum = 0.0
    private var pitchSum = 0.0

    init(windowDuration: TimeInterval = Self.defaultWindowDuration) {
        self.windowDuration = max(0, windowDuration)
    }

    mutating func deviation(
        for attitude: SliccAgentAvatarAttitude, at timestamp: TimeInterval
    ) -> SliccAgentAvatarAttitude {
        samples.append(.init(attitude: attitude, timestamp: timestamp))
        rollSum += attitude.roll
        pitchSum += attitude.pitch
        discardSamples(olderThan: timestamp - windowDuration)

        let count = Double(samples.count - firstSampleIndex)
        return .init(
            roll: attitude.roll - rollSum / count,
            pitch: attitude.pitch - pitchSum / count)
    }

    mutating func reset() {
        samples.removeAll(keepingCapacity: true)
        firstSampleIndex = 0
        rollSum = 0
        pitchSum = 0
    }

    private mutating func discardSamples(olderThan cutoff: TimeInterval) {
        while firstSampleIndex < samples.count, samples[firstSampleIndex].timestamp < cutoff {
            rollSum -= samples[firstSampleIndex].attitude.roll
            pitchSum -= samples[firstSampleIndex].attitude.pitch
            firstSampleIndex += 1
        }
        if firstSampleIndex >= 1_024, firstSampleIndex * 2 >= samples.count {
            samples.removeFirst(firstSampleIndex)
            firstSampleIndex = 0
        }
    }
}

enum SliccAgentAvatarInterfaceOrientation: Equatable, Sendable {
    case portrait
    case portraitUpsideDown
    case landscapeLeft
    case landscapeRight
}

/// Lifecycle seam for deterministic previews/tests and the CoreMotion implementation.
@MainActor
protocol SliccAgentAvatarTiltSource: AnyObject {
    var isDeviceMotionAvailable: Bool { get }
    func startDeviceMotionUpdates(
        _ handler: @escaping @MainActor (SliccAgentAvatarAttitude) -> Void)
    func stopDeviceMotionUpdates()
}

@MainActor
final class CoreMotionSliccAgentAvatarTiltSource: SliccAgentAvatarTiltSource {
    private let manager: CMMotionManager

    init(manager: CMMotionManager = CMMotionManager()) {
        self.manager = manager
    }

    var isDeviceMotionAvailable: Bool { manager.isDeviceMotionAvailable }

    func startDeviceMotionUpdates(
        _ handler: @escaping @MainActor (SliccAgentAvatarAttitude) -> Void
    ) {
        guard isDeviceMotionAvailable else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 60.0
        manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { motion, _ in
            guard let attitude = motion?.attitude else { return }
            Task { @MainActor in
                handler(.init(roll: attitude.roll, pitch: attitude.pitch))
            }
        }
    }

    func stopDeviceMotionUpdates() {
        manager.stopDeviceMotionUpdates()
    }
}

/// Deterministic source for previews and tests.
@MainActor
final class FixedSliccAgentAvatarTiltSource: SliccAgentAvatarTiltSource {
    var isDeviceMotionAvailable: Bool
    private(set) var startCallCount = 0
    private(set) var stopCallCount = 0
    private let attitude: SliccAgentAvatarAttitude

    init(
        roll: Double, pitch: Double,
        isDeviceMotionAvailable: Bool = true
    ) {
        attitude = .init(roll: roll, pitch: pitch)
        self.isDeviceMotionAvailable = isDeviceMotionAvailable
    }

    func startDeviceMotionUpdates(
        _ handler: @escaping @MainActor (SliccAgentAvatarAttitude) -> Void
    ) {
        startCallCount += 1
        guard isDeviceMotionAvailable else { return }
        handler(attitude)
    }

    func stopDeviceMotionUpdates() {
        stopCallCount += 1
    }
}

/// Pure conversion from device attitude to the avatar geometry's pupil offset.
struct SliccAgentAvatarTiltMapping: Sendable {
    static let defaultFullTravelTilt = Double.pi / 6

    let fullTravelTilt: Double

    init(fullTravelTilt: Double = Self.defaultFullTravelTilt) {
        self.fullTravelTilt = fullTravelTilt
    }

    func pupilOffset(
        for attitude: SliccAgentAvatarAttitude,
        geometry: SliccAgentAvatarGeometry,
        reduceMotion: Bool,
        isDeviceMotionAvailable: Bool,
        orientation: SliccAgentAvatarInterfaceOrientation = .portrait
    ) -> SliccAgentAvatarGeometry.Point {
        guard !reduceMotion, isDeviceMotionAvailable, fullTravelTilt > 0 else {
            return .init(x: 0, y: 0)
        }
        let scale = geometry.maxPupilTravel / fullTravelTilt
        let screenAxes = screenAxes(for: attitude, orientation: orientation)
        return geometry.clampedPupilOffset(.init(x: screenAxes.x * scale, y: screenAxes.y * scale))
    }

    private func screenAxes(
        for attitude: SliccAgentAvatarAttitude,
        orientation: SliccAgentAvatarInterfaceOrientation
    ) -> SliccAgentAvatarGeometry.Point {
        switch orientation {
        case .portrait:
            .init(x: attitude.roll, y: -attitude.pitch)
        case .portraitUpsideDown:
            .init(x: -attitude.roll, y: attitude.pitch)
        case .landscapeLeft:
            .init(x: -attitude.pitch, y: -attitude.roll)
        case .landscapeRight:
            .init(x: attitude.pitch, y: attitude.roll)
        }
    }

    func rateLimitedOffset(
        from current: SliccAgentAvatarGeometry.Point,
        toward target: SliccAgentAvatarGeometry.Point,
        maximumDistance: Double
    ) -> SliccAgentAvatarGeometry.Point {
        let x = target.x - current.x
        let y = target.y - current.y
        let distance = hypot(x, y)
        let allowedDistance = max(0, maximumDistance)
        guard distance > allowedDistance, distance > 0 else { return target }
        let scale = allowedDistance / distance
        return .init(
            x: current.x + x * scale,
            y: current.y + y * scale)
    }
}

@MainActor
final class SliccAgentAvatarTiltController: ObservableObject {
    private static let maximumSampleInterval: TimeInterval = 1.0 / 30.0

    @Published private(set) var pupilOffset = SliccAgentAvatarGeometry.Point(x: 0, y: 0)

    private let source: any SliccAgentAvatarTiltSource
    private let mapping: SliccAgentAvatarTiltMapping
    private let interfaceOrientation: @MainActor () -> SliccAgentAvatarInterfaceOrientation
    private let clock: @MainActor () -> TimeInterval
    private var geometry: SliccAgentAvatarGeometry?
    private var baseline = SliccAgentAvatarTiltBaseline()
    private var lastSampleTime: TimeInterval?
    private var motionDisabled = false
    private var isUpdating = false

    init(
        source: any SliccAgentAvatarTiltSource,
        mapping: SliccAgentAvatarTiltMapping = .init(),
        clock: @escaping @MainActor () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        interfaceOrientation: @escaping @MainActor () -> SliccAgentAvatarInterfaceOrientation = {
            SliccAgentAvatarTiltController.currentInterfaceOrientation
        }
    ) {
        self.source = source
        self.mapping = mapping
        self.clock = clock
        self.interfaceOrientation = interfaceOrientation
    }

    func update(geometry: SliccAgentAvatarGeometry, motionDisabled: Bool) {
        self.geometry = geometry
        self.motionDisabled = motionDisabled
        guard geometry.eyes == .open, !motionDisabled, source.isDeviceMotionAvailable else {
            stopAndCenter()
            return
        }
        guard !isUpdating else { return }
        isUpdating = true
        source.startDeviceMotionUpdates { [weak self] attitude in
            self?.receive(attitude)
        }
    }

    func stopAndCenter() {
        if isUpdating { source.stopDeviceMotionUpdates() }
        isUpdating = false
        pupilOffset = .init(x: 0, y: 0)
        baseline.reset()
        lastSampleTime = nil
    }

    private func receive(_ attitude: SliccAgentAvatarAttitude) {
        guard let geometry else { return }
        let sampleTime = clock()
        let relativeAttitude = baseline.deviation(for: attitude, at: sampleTime)
        let target = mapping.pupilOffset(
            for: relativeAttitude, geometry: geometry, reduceMotion: motionDisabled,
            isDeviceMotionAvailable: source.isDeviceMotionAvailable,
            orientation: interfaceOrientation())
        let elapsed =
            lastSampleTime.map {
                min(max(0, sampleTime - $0), Self.maximumSampleInterval)
            } ?? 0
        lastSampleTime = sampleTime
        pupilOffset = mapping.rateLimitedOffset(
            from: pupilOffset, toward: target,
            maximumDistance: geometry.eyeDiameter * elapsed)
    }

    private static var currentInterfaceOrientation: SliccAgentAvatarInterfaceOrientation {
        let orientation = UIApplication.shared.connectedScenes.lazy
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }?
            .interfaceOrientation
        switch orientation {
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
        }
    }
}
