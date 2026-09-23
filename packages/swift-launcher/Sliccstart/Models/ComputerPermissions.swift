import ApplicationServices
import CoreGraphics
import Foundation

/// Screen Recording and Accessibility probes, injectable so tests never trip
/// TCC on the machine they run on.
///
/// Both permissions are lazy: the computer follower only asks on the first
/// `computer.native.capture` / `computer.native.input`, and a denial names
/// System Settings rather than failing closed with an empty string.
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

    /// Exact strings the leader surfaces on `computer.native.error` (capture)
    /// and `computer.native.input.result` (input).
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

/// Both TCC grants as they stand right now.
///
/// Read without prompting, so it is safe to poll: `hello` carries it to the
/// leader, and the leader's `computer add ssh` reads `capabilities.computer` to
/// decide whether to skip the `screencapture`/`cliclick` tray-exec fallback
/// (#3387). Advertising a grant this peer does not hold costs the agent a
/// working fallback.
struct ComputerGrants: Equatable {
    var screenRecording: Bool
    var accessibility: Bool

    /// What `capabilities.computer` is defined to mean: this peer can capture
    /// its own screen. Input rides on Accessibility and is reported in the MOTD
    /// instead — the wire has one boolean, and capture is what the leader's
    /// fallback decision turns on.
    var canCaptureNatively: Bool { screenRecording }
}

struct ComputerPermissions {
    var probe: ComputerPermissionProbe

    init(probe: ComputerPermissionProbe = .live) {
        self.probe = probe
    }

    /// Non-prompting read of both grants. Never call `request*` here: this runs
    /// on a poll, and a prompt per tick would be unusable.
    func grants() -> ComputerGrants {
        ComputerGrants(
            screenRecording: probe.screenRecordingGranted(),
            accessibility: probe.accessibilityGranted())
    }

    /// First capture: prompt if needed, then fail with a System Settings path.
    func ensureScreenRecording() throws {
        if probe.screenRecordingGranted() { return }
        if probe.requestScreenRecording() { return }
        throw ComputerPermissionError.screenRecording
    }

    /// First input: prompt if needed, then fail with a System Settings path.
    func ensureAccessibility() throws {
        if probe.accessibilityGranted() { return }
        if probe.requestAccessibility() { return }
        throw ComputerPermissionError.accessibility
    }
}
