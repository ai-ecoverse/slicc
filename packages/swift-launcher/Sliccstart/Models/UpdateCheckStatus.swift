import AppUpdater
import Foundation






enum UpdateCheckStatus: Equatable {
    case idle
    case checking
    case upToDate
    
    
    case noInstallableRelease
    
    
    
    
    
    case translocated
    
    
    
    case rateLimited(until: Date)
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
        if let limited = error as? GitHubRateLimitedError {
            return .rateLimited(until: limited.retryAfter)
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
        case .rateLimited:
            return "Update Check Rate-Limited"
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
        case .rateLimited(let until):
            let time = until.formatted(date: .omitted, time: .shortened)
            return "GitHub's API limit for your network is used up until \(time). "
                + "Shared networks such as a VPN exhaust it quickly; setting GH_TOKEN raises the limit."
        case .failed(let message):
            return "\(message) Click to try again."
        }
    }

    var isRateLimited: Bool {
        if case .rateLimited = self { return true }
        return false
    }

    
    
    var allowsRetry: Bool {
        self != .checking
    }
}
