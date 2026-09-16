import AppKit
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "DefaultBrowser")

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

    static let handledSchemes = ["http", "https"]

    static let probeURL = URL(string: "https://www.sliccy.ai")!

    static func isDefault(
        bundleURL: URL = Bundle.main.bundleURL,
        system: any DefaultBrowserSystem = WorkspaceDefaultBrowserSystem()
    ) -> Bool {
        matches(handlerURL: system.handlerURL(toOpen: probeURL), bundleURL: bundleURL)
    }

    static func matches(handlerURL: URL?, bundleURL: URL) -> Bool {
        guard let handlerURL else { return false }
        return canonicalPath(handlerURL) == canonicalPath(bundleURL)
    }

    static var isRegistrable: Bool { SliccBootstrapper.isBundled }

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
