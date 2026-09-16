import AppUpdater
import Foundation

enum UpdateCheckStatus: Equatable {
    case idle
    case checking
    case upToDate

    case noInstallableRelease

    case translocated
    case failed(String)

    static func from(error: Error) -> UpdateCheckStatus {
        if error.isCancelled {
            return .upToDate
        }
        if case AppUpdater.Error.noValidUpdate = error {
            return .noInstallableRelease
        }
        if isReadOnlyVolumeError(error) {
            return .translocated
        }
        return .failed(message(for: error))
    }

    private static func isReadOnlyVolumeError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileWriteVolumeReadOnlyError
    }

    private static func message(for error: Error) -> String {
        if let urlError = error as? URLError {
            return urlError.localizedDescription
        }
        return String(describing: error)
    }

    var buttonTitle: String {
        switch self {
        case .idle:
            return "Check for Updates"
        case .checking:
            return "Checking for Updates…"
        case .upToDate:
            return "Up to Date"
        case .noInstallableRelease:
            return "No Installable Update"
        case .translocated:
            return "Move to Applications to Update"
        case .failed:
            return "Update Check Failed"
        }
    }

    var detail: String? {
        switch self {
        case .idle, .checking:
            return nil
        case .upToDate:
            return "You are running the newest released version."
        case .noInstallableRelease:
            return "The newest releases ship no macOS launcher build yet. Click to check again."
        case .translocated:
            return "Sliccstart is running from a temporary, read-only location. Move it to your Applications folder and relaunch, then click to try again."
        case .failed(let message):
            return "\(message) Click to try again."
        }
    }

    var allowsRetry: Bool {
        self != .checking
    }
}
