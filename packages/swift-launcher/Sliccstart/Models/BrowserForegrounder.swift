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
/// activation of our own).
///
/// The leader runs on its own user-data-dir, so the user's normal profile may
/// be a second process of the same bundle. Activation therefore targets the
/// process launched with the leader's `--remote-debugging-port`; with several
/// instances and no unique match nothing is activated rather than guessing.
/// The LaunchServices path addresses a bundle, not a process, so it is only
/// taken when exactly one instance of that bundle runs.
struct BrowserForegrounder {
    enum Outcome: Equatable {
        case notRunning
        case activated
        case reopened
        case refused
        /// Several instances run and none is identifiably the leader.
        case ambiguous
    }

    struct Services {
        var instancePIDs: (URL) -> [pid_t]
        /// The process's argv, or `nil` when it cannot be read.
        var arguments: (pid_t) -> [String]?
        var isSelfActive: () -> Bool
        /// `NSApp.yieldActivation(to:)` + `activate(from: .current)`.
        var yieldAndActivate: (pid_t) -> Bool
        var reopenViaLaunchServices: (URL) -> Void
    }

    var services: Services = .live

    @discardableResult
    func foreground(_ leader: LeaderBrowserEndpoint) -> Outcome {
        let bundleURL = URL(fileURLWithPath: leader.appPath).standardizedFileURL
        let pids = services.instancePIDs(bundleURL)
        let outcome: Outcome
        if pids.isEmpty {
            outcome = .notRunning
        } else if let pid = leaderPID(among: pids, cdpPort: leader.cdpPort) {
            if services.isSelfActive(), services.yieldAndActivate(pid) {
                outcome = .activated
            } else if pids.count == 1 {
                services.reopenViaLaunchServices(bundleURL)
                outcome = .reopened
            } else {
                // Last resort: may still be refused, but never targets another instance via LaunchServices.
                outcome = services.yieldAndActivate(pid) ? .activated : .refused
            }
        } else {
            outcome = .ambiguous
        }
        log.info("foreground: \(String(describing: outcome), privacy: .public) (instances=\(pids.count, privacy: .public))")
        return outcome
    }

    /// A sole instance is the leader (the endpoint was already verified to own
    /// the CDP port); otherwise exactly one instance must carry the port flag.
    private func leaderPID(among pids: [pid_t], cdpPort: UInt16) -> pid_t? {
        if pids.count == 1 { return pids[0] }
        let flag = "--remote-debugging-port=\(cdpPort)"
        let matches = pids.filter { services.arguments($0)?.contains(flag) == true }
        return matches.count == 1 ? matches[0] : nil
    }
}

extension BrowserForegrounder.Services {
    static let live = BrowserForegrounder.Services(
        instancePIDs: { bundleURL in
            NSWorkspace.shared.runningApplications
                .filter { $0.bundleURL?.standardizedFileURL == bundleURL }
                .map(\.processIdentifier)
        },
        arguments: processArguments(of:),
        isSelfActive: { NSRunningApplication.current.isActive },
        yieldAndActivate: { pid in
            guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
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

    /// Reads argv through `KERN_PROCARGS2`: an `Int32` argc, the executable
    /// path, NUL padding, then argc NUL-terminated arguments.
    static func processArguments(of pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
        return parseProcArgs(Array(buffer.prefix(size)))
    }

    static func parseProcArgs(_ bytes: [UInt8]) -> [String]? {
        let headerSize = MemoryLayout<Int32>.size
        guard bytes.count > headerSize else { return nil }
        let argc = bytes.prefix(headerSize).withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
        guard argc > 0 else { return [] }
        var index = headerSize
        while index < bytes.count, bytes[index] != 0 { index += 1 }  // executable path
        while index < bytes.count, bytes[index] == 0 { index += 1 }  // padding
        var arguments: [String] = []
        while arguments.count < argc, index < bytes.count {
            let end = bytes[index...].firstIndex(of: 0) ?? bytes.count
            guard let argument = String(bytes: bytes[index..<end], encoding: .utf8) else { return nil }
            arguments.append(argument)
            index = end + 1
        }
        return arguments.count == argc ? arguments : nil
    }
}
