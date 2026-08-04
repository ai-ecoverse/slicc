import AppUpdater
import Foundation

/// Outcome of the most recent `AppUpdater.check()` run, so the launcher can
/// tell the user what happened. `AppUpdater` reports every failure through a
/// callback and otherwise only publishes a downloaded bundle, so without this
/// a failed or empty check is indistinguishable from "never checked": the
/// footer just kept offering "Check for Updates" while newer releases existed.
enum UpdateCheckStatus: Equatable {
    case idle
    case checking
    case upToDate
    /// The release listing was reachable but shipped no installable macOS
    /// asset newer than the running build.
    case noInstallableRelease
    /// The running `.app` sits on a read-only volume, so `AppUpdater` cannot
    /// stage a download next to it. This is Gatekeeper's "App Translocation":
    /// a quarantined `.app` launched without first being moved to
    /// `/Applications` runs from a randomized, read-only copy under
    /// `.../T/AppTranslocation/...`.
    case translocated
    case failed(String)

    /// Classifies an `AppUpdater` failure. `AUError.cancelled` is how
    /// `findViableUpdate` reports "the newest release is not newer than the
    /// running build", and `AppUpdater.Error.noValidUpdate` means no release in
    /// the fetched window carried an installable asset.
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

    /// `AppUpdater.checkThrowing()` allocates its download scratch directory
    /// with `appropriateFor: Bundle.main.bundleURL` before it ever reaches the
    /// network (see `AppUpdater.swift`'s `update(with:belongs:)`), so a
    /// translocated launch fails every check with
    /// `NSFileWriteVolumeReadOnlyError` — indistinguishable from a genuine
    /// network/API failure unless the error code is inspected directly.
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

    /// Tooltip detail; `nil` when the title says everything.
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

    /// Whether clicking should start another check. Only the in-flight state
    /// blocks a retry.
    var allowsRetry: Bool {
        self != .checking
    }
}
