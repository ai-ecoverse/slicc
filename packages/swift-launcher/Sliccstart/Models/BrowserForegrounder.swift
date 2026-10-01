import AppKit
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "BrowserForegrounder")

/// Brings the leader browser forward after a routed link was opened in it.
///
/// macOS 14 activation is cooperative: activating *another* app is honored
/// only when the caller is the active app and explicitly yields to it. A bare
/// `NSRunningApplication.activate()` is therefore silently refused whenever
/// Sliccstart is not frontmost at that moment — a cold start that waited for
/// the leader to boot, or a launcher window ordering in after LaunchServices
/// activated us — and the new tab stays hidden behind whatever the user was
/// looking at.
///
/// So: yield-and-activate while we hold activation; otherwise ask
/// LaunchServices to reopen the browser (what a Dock click does, which needs no
/// activation of our own). The LaunchServices path addresses a bundle, not a
/// process, so it is only taken when exactly one instance of that bundle runs —
/// with the user's own profile open in the same browser it could foreground
/// the wrong instance.
struct BrowserForegrounder {
    enum Outcome: Equatable {
        case notRunning
        case activated
        case reopened
        case refused
    }

    struct Services {
        var instanceCount: (URL) -> Int
        var isSelfActive: () -> Bool
        /// `NSApp.yieldActivation(to:)` + `activate(from: .current)`.
        var yieldAndActivate: (URL) -> Bool
        var reopenViaLaunchServices: (URL) -> Void
    }

    var services: Services = .live

    @discardableResult
    func foreground(appPath: String) -> Outcome {
        let bundleURL = URL(fileURLWithPath: appPath).standardizedFileURL
        let instances = services.instanceCount(bundleURL)
        let outcome: Outcome
        if instances == 0 {
            outcome = .notRunning
        } else if services.isSelfActive(), services.yieldAndActivate(bundleURL) {
            outcome = .activated
        } else if instances == 1 {
            services.reopenViaLaunchServices(bundleURL)
            outcome = .reopened
        } else {
            // Last resort: may still be refused, but never targets another instance via LaunchServices.
            outcome = services.yieldAndActivate(bundleURL) ? .activated : .refused
        }
        log.info("foreground: \(String(describing: outcome), privacy: .public) (instances=\(instances, privacy: .public))")
        return outcome
    }
}

extension BrowserForegrounder.Services {
    static let live = BrowserForegrounder.Services(
        instanceCount: { runningInstances(of: $0).count },
        isSelfActive: { NSRunningApplication.current.isActive },
        yieldAndActivate: { bundleURL in
            guard let app = runningInstances(of: bundleURL).first else { return false }
            NSApp.yieldActivation(to: app)
            return app.activate(from: .current, options: [])
        },
        reopenViaLaunchServices: { bundleURL in
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { _, error in
                if let error {
                    log.error("foreground: LaunchServices reopen failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    )

    private static func runningInstances(of bundleURL: URL) -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.standardizedFileURL == bundleURL }
    }
}
