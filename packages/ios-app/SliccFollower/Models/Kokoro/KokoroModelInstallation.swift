import Combine
import Foundation

enum KokoroModelInstallationState: Equatable, Sendable {
    case notInstalled
    case awaitingConsent
    case downloading(fraction: Double)
    case installed
    case failed(KokoroModelProvisioningError)
}

/// User-driven lifecycle for the managed Kokoro model pack.
///
/// Dictated replies never call this object. Only Settings can cross the
/// consent boundary and start provisioning; speech merely observes files that
/// are already complete and otherwise uses the system voice.
@MainActor
final class KokoroModelInstallation: ObservableObject {
    static let shared: KokoroModelInstallation = {
        #if DEBUG
            KokoroModelInstallation(initialState: UITestHooks.kokoroModelState)
        #else
            KokoroModelInstallation()
        #endif
    }()

    @Published private(set) var state: KokoroModelInstallationState
    let usesDeveloperPack: Bool

    private let managedDirectory: URL?
    private let resourceDownloader: any KokoroAneResourceDownloading
    private let presenceChecker: any KokoroModelPresenceChecking
    private let fileManager: FileManager
    private var downloadTask: Task<Void, Never>?
    private var activeDownloadID: UUID?

    init(
        developmentDirectory: URL? = KokoroDevelopmentModels.directoryURL(),
        managedDirectory: URL? = KokoroAneResourceDownloader.defaultModelsDirectory(),
        resourceDownloader: any KokoroAneResourceDownloading = KokoroAneResourceDownloader(),
        presenceChecker: any KokoroModelPresenceChecking = KokoroModelPresenceChecker(),
        fileManager: FileManager = .default,
        initialState: KokoroModelInstallationState? = nil
    ) {
        self.managedDirectory = managedDirectory
        self.resourceDownloader = resourceDownloader
        self.presenceChecker = presenceChecker
        self.fileManager = fileManager
        usesDeveloperPack = developmentDirectory != nil
        if let initialState {
            state = initialState
        } else if developmentDirectory != nil {
            state = .installed
        } else if let managedDirectory,
            Self.managedInstallationPresent(
                in: managedDirectory, presenceChecker: presenceChecker, fileManager: fileManager)
        {
            state = .installed
        } else {
            state = .notInstalled
        }
    }

    func requestInstallation() {
        guard !usesDeveloperPack else { return }
        switch state {
        case .notInstalled, .failed:
            state = .awaitingConsent
        case .awaitingConsent, .downloading, .installed:
            break
        }
    }

    func declineConsent() {
        guard case .awaitingConsent = state else { return }
        state = .notInstalled
    }

    func confirmInstallation() {
        guard case .awaitingConsent = state, let managedDirectory else {
            if managedDirectory == nil {
                state = .failed(.storageFailure("Application Support is unavailable"))
            }
            return
        }
        let downloadID = UUID()
        activeDownloadID = downloadID
        state = .downloading(fraction: 0)
        downloadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let resolved = try await resourceDownloader.ensureModels(
                    variant: .english,
                    directory: managedDirectory,
                    progressHandler: { [weak self] progress in
                        self?.updateProgress(progress, downloadID: downloadID)
                    })
                guard activeDownloadID == downloadID else {
                    try? removeManagedDirectory()
                    return
                }
                guard
                    Self.managedInstallationPresent(
                        in: resolved, presenceChecker: presenceChecker, fileManager: fileManager)
                else {
                    throw KokoroModelProvisioningError.incompleteDownload(missing: [])
                }
                finish(downloadID: downloadID, state: .installed)
            } catch {
                guard activeDownloadID == downloadID else {
                    try? removeManagedDirectory()
                    return
                }
                let failure: KokoroModelProvisioningError
                if let typed = error as? KokoroModelProvisioningError {
                    failure = typed
                } else if error is CancellationError {
                    failure = .interrupted
                } else {
                    failure = .httpFailure(error.localizedDescription)
                }
                finish(downloadID: downloadID, state: .failed(failure))
            }
        }
    }

    func cancelDownload() {
        guard case .downloading = state else { return }
        activeDownloadID = nil
        downloadTask?.cancel()
        downloadTask = nil
        do {
            try removeManagedDirectory()
            state = .notInstalled
        } catch {
            state = .failed(.storageFailure(error.localizedDescription))
        }
    }

    func removeInstallation() {
        guard !usesDeveloperPack else { return }
        activeDownloadID = nil
        downloadTask?.cancel()
        downloadTask = nil
        do {
            try removeManagedDirectory()
            state = .notInstalled
        } catch {
            state = .failed(.storageFailure(error.localizedDescription))
        }
    }

    private func updateProgress(_ progress: Progress, downloadID: UUID) {
        guard activeDownloadID == downloadID else { return }
        let fraction = progress.fractionCompleted
        state = .downloading(fraction: fraction.isFinite ? min(max(fraction, 0), 1) : 0)
    }

    private func finish(downloadID: UUID, state: KokoroModelInstallationState) {
        guard activeDownloadID == downloadID else { return }
        activeDownloadID = nil
        downloadTask = nil
        self.state = state
    }

    private func removeManagedDirectory() throws {
        guard let managedDirectory, fileManager.fileExists(atPath: managedDirectory.path) else {
            return
        }
        try fileManager.removeItem(at: managedDirectory)
    }

    private static func managedInstallationPresent(
        in directory: URL,
        presenceChecker: any KokoroModelPresenceChecking,
        fileManager: FileManager
    ) -> Bool {
        presenceChecker.modelsPresent(in: directory)
            && fileManager.fileExists(
                atPath: directory.appendingPathComponent(
                    KokoroAneResourceDownloader.completionMarker
                ).path)
    }
}
