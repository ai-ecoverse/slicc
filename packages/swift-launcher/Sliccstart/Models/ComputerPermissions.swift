import ApplicationServices
import CoreGraphics
import Foundation







struct ComputerPermissionProbe: Sendable {
    var screenRecordingGranted: @Sendable () -> Bool
    var requestScreenRecording: @Sendable () -> Bool
    var accessibilityGranted: @Sendable () -> Bool
    var requestAccessibility: @Sendable () -> Bool

    static let live = ComputerPermissionProbe(
        screenRecordingGranted: { CGPreflightScreenCaptureAccess() },
        requestScreenRecording: { CGRequestScreenCaptureAccess() },
        accessibilityGranted: { AXIsProcessTrusted() },
        requestAccessibility: {
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            return AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        }
    )
}

enum ComputerPermissionKind: Equatable {
    case screenRecording
    case accessibility
}

enum ComputerPermissionError: Error, Equatable {
    case screenRecording
    case accessibility

    
    
    var message: String {
        switch self {
        case .screenRecording:
            return ComputerPermissionError.screenRecordingMessage
        case .accessibility:
            return ComputerPermissionError.accessibilityMessage
        }
    }

    static let screenRecordingMessage =
        "Screen Recording is not allowed. Grant it in System Settings → Privacy & Security → Screen Recording, then try again."
    static let accessibilityMessage =
        "Accessibility is not allowed. Grant it in System Settings → Privacy & Security → Accessibility, then try again."
}

struct ComputerPermissions {
    var probe: ComputerPermissionProbe

    init(probe: ComputerPermissionProbe = .live) {
        self.probe = probe
    }

    
    func ensureScreenRecording() throws {
        if probe.screenRecordingGranted() { return }
        if probe.requestScreenRecording() { return }
        throw ComputerPermissionError.screenRecording
    }

    
    func ensureAccessibility() throws {
        if probe.accessibilityGranted() { return }
        if probe.requestAccessibility() { return }
        throw ComputerPermissionError.accessibility
    }
}
