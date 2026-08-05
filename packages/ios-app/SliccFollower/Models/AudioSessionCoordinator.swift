import AVFoundation

@MainActor
protocol AudioSessionBackend: AnyObject {
    var category: AVAudioSession.Category { get }
    var mode: AVAudioSession.Mode { get }
    var categoryOptions: AVAudioSession.CategoryOptions { get }
    var preferredSampleRate: Double { get }

    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws
    func setPreferredSampleRate(_ sampleRate: Double) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

@MainActor
private final class SystemAudioSessionBackend: AudioSessionBackend {
    private let session = AVAudioSession.sharedInstance()

    var category: AVAudioSession.Category { session.category }
    var mode: AVAudioSession.Mode { session.mode }
    var categoryOptions: AVAudioSession.CategoryOptions { session.categoryOptions }
    var preferredSampleRate: Double { session.preferredSampleRate }

    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws {
        try session.setCategory(category, mode: mode, options: options)
    }

    func setPreferredSampleRate(_ sampleRate: Double) throws {
        try session.setPreferredSampleRate(sampleRate)
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        try session.setActive(active, options: options)
    }
}

@MainActor
protocol AudioSessionCoordinating: AnyObject {
    func beginRecording() throws
    func endRecording()
    func beginPlayback(preferredSampleRate: Double?) throws
    func endPlayback()
}

/// The sole owner of `AVAudioSession` configuration. Recording and playback
/// leases are exclusive, and every lease restores the session it inherited.
@MainActor
final class AudioSessionCoordinator: AudioSessionCoordinating {
    static let shared = AudioSessionCoordinator(backend: SystemAudioSessionBackend())

    private struct Snapshot {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
        let preferredSampleRate: Double
        let wasActive: Bool
    }

    private enum Lease {
        case recording(Snapshot)
        case playback(Snapshot)
    }

    private let backend: any AudioSessionBackend
    private var lease: Lease?
    private var isActive = false

    init(backend: any AudioSessionBackend) {
        self.backend = backend
    }

    func beginRecording() throws {
        let snapshot = try beginLease()
        do {
            try backend.setCategory(.record, mode: .measurement, options: .duckOthers)
            try backend.setActive(true, options: [])
            isActive = true
            lease = .recording(snapshot)
        } catch {
            restore(snapshot)
            throw error
        }
    }

    func endRecording() {
        guard case .recording(let snapshot) = lease else { return }
        lease = nil
        restore(snapshot)
    }

    func beginPlayback(preferredSampleRate: Double?) throws {
        let snapshot = try beginLease()
        do {
            try backend.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            if let preferredSampleRate {
                try backend.setPreferredSampleRate(preferredSampleRate)
            }
            try backend.setActive(true, options: [])
            isActive = true
            lease = .playback(snapshot)
        } catch {
            restore(snapshot)
            throw error
        }
    }

    func endPlayback() {
        guard case .playback(let snapshot) = lease else { return }
        lease = nil
        restore(snapshot)
    }

    private func beginLease() throws -> Snapshot {
        guard lease == nil else { throw AudioSessionCoordinatorError.busy }
        return Snapshot(
            category: backend.category,
            mode: backend.mode,
            options: backend.categoryOptions,
            preferredSampleRate: backend.preferredSampleRate,
            wasActive: isActive)
    }

    private func restore(_ snapshot: Snapshot) {
        if isActive {
            try? backend.setActive(false, options: .notifyOthersOnDeactivation)
        }
        try? backend.setCategory(
            snapshot.category, mode: snapshot.mode, options: snapshot.options)
        try? backend.setPreferredSampleRate(snapshot.preferredSampleRate)
        if snapshot.wasActive {
            try? backend.setActive(true, options: [])
        }
        isActive = snapshot.wasActive
    }
}

enum AudioSessionCoordinatorError: LocalizedError {
    case busy

    var errorDescription: String? {
        "Another audio operation is still active"
    }
}
