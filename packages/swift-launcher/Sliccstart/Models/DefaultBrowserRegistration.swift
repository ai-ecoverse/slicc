import AppKit
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "DefaultBrowser")

/// Registers Sliccstart as the macOS default web browser, and reports whether
/// it currently holds that role.
///
/// Sliccstart never renders a page itself: taking the http/https handler role
/// only means links from other apps arrive here and are then opened as tabs in
/// the SLICC-controlled leader browser (`IncomingURLRouter`). The role is
/// therefore only offered alongside "launch browser at startup" — without a
/// leader to hand links to, becoming the default browser would swallow them.
/// The LaunchServices operations the registration needs. `NSWorkspace` supplies
/// them in production; tests supply a double, because the real calls rewrite
/// the user's system-wide handler and raise a modal confirmation panel.
protocol DefaultBrowserSystem {
    func handlerURL(toOpen url: URL) -> URL?
    func setDefaultApplication(at bundleURL: URL, toOpenURLsWithScheme scheme: String) async -> Error?
}

struct WorkspaceDefaultBrowserSystem: DefaultBrowserSystem {
    let workspace: NSWorkspace

    init(workspace: NSWorkspace = .shared) {
        self.workspace = workspace
    }

    func handlerURL(toOpen url: URL) -> URL? {
        workspace.urlForApplication(toOpen: url)
    }

    func setDefaultApplication(at bundleURL: URL, toOpenURLsWithScheme scheme: String) async -> Error? {
        await withCheckedContinuation { continuation in
            workspace.setDefaultApplication(at: bundleURL, toOpenURLsWithScheme: scheme) { error in
                continuation.resume(returning: error)
            }
        }
    }
}

enum DefaultBrowserRegistration {
    /// Schemes a default browser has to claim. `assemble-app.mjs` declares the
    /// same pair in `CFBundleURLTypes`; LaunchServices refuses a handler change
    /// for a scheme the bundle does not advertise.
    static let handledSchemes = ["http", "https"]

    /// Asks LaunchServices who currently handles web links. Any http(s) URL
    /// resolves to the same handler, so the value is only a probe.
    static let probeURL = URL(string: "https://www.sliccy.ai")!

    static func isDefault(
        bundleURL: URL = Bundle.main.bundleURL,
        system: any DefaultBrowserSystem = WorkspaceDefaultBrowserSystem()
    ) -> Bool {
        matches(handlerURL: system.handlerURL(toOpen: probeURL), bundleURL: bundleURL)
    }

    /// LaunchServices answers with a canonical, symlink-resolved URL that may
    /// or may not carry a trailing slash, so comparing `URL` values directly
    /// reports a false negative.
    static func matches(handlerURL: URL?, bundleURL: URL) -> Bool {
        guard let handlerURL else { return false }
        return canonicalPath(handlerURL) == canonicalPath(bundleURL)
    }

    /// `false` for a build LaunchServices cannot record — a `swift run` binary
    /// has no `.app` bundle, so the prompt would either not appear or not
    /// stick. The UI disables the control instead of offering a no-op.
    static var isRegistrable: Bool { SliccBootstrapper.isBundled }

    /// Claim both web schemes. macOS shows its own confirmation panel for the
    /// first one, and a user who declines leaves the handler unchanged — hence
    /// the result is re-read from LaunchServices rather than assumed from the
    /// absence of an error.
    static func makeDefault(
        bundleURL: URL = Bundle.main.bundleURL,
        system: any DefaultBrowserSystem = WorkspaceDefaultBrowserSystem(),
        report: (Error) -> Void = { LauncherErrorReport.report(.defaultBrowser, $0) }
    ) async -> Bool {
        for scheme in handledSchemes {
            if let error = await system.setDefaultApplication(at: bundleURL, toOpenURLsWithScheme: scheme) {
                log.error("makeDefault: \(scheme, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                report(error)
                return isDefault(bundleURL: bundleURL, system: system)
            }
        }
        let succeeded = isDefault(bundleURL: bundleURL, system: system)
        log.info("makeDefault: isDefault = \(succeeded, privacy: .public)")
        return succeeded
    }

    private static func canonicalPath(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}
