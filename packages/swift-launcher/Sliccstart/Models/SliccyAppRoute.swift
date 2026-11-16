import AppKit
import Foundation

struct SliccstartRemovalContext {
    let url: URL
    let bundleIdentifier: String?
    let isDirectory: Bool
    let isReadOnly: Bool
    let isWritable: Bool
    let isDevelopment: Bool

    var canRevealForRemoval: Bool {
        url.isFileURL && url.pathExtension == "app" && bundleIdentifier == "com.slicc.sliccstart"
            && SliccyApplicationValidator.isInstalledLocation(url) && isDirectory && !isReadOnly && isWritable && !isDevelopment
    }

    static func live() -> SliccstartRemovalContext {
        let url = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .volumeIsReadOnlyKey])
        #if DEBUG
            let development = true
        #else
            let development = false
        #endif
        return .init(
            url: url, bundleIdentifier: Bundle.main.bundleIdentifier,
            isDirectory: values?.isDirectory == true, isReadOnly: values?.volumeIsReadOnly != false,
            isWritable: FileManager.default.isWritableFile(atPath: url.path)
                && FileManager.default.isWritableFile(atPath: url.deletingLastPathComponent().path),
            isDevelopment: development
        )
    }
}

enum SliccyRouteError: LocalizedError {
    case unsuitableApp
    case launchFailed
    case notRunning
    case removalUnavailable
    case revealFailed(URL)

    var errorDescription: String? {
        switch self {
        case .unsuitableApp:
            "Sliccy was found but could not be verified as a compatible installed app. "
                + "Install a signed release in Applications, then try again. Keep using Sliccstart meanwhile."
        case .launchFailed:
            "Sliccy did not confirm a successful launch of the verified app. Sliccstart is still available; try opening Sliccy in Finder."
        case .notRunning:
            "Open Sliccy successfully before removing Sliccstart. No app was removed or quit."
        case .revealFailed(let url):
            "Finder could not select \(url.path). Open that location manually in Finder. No app was quit or removed."
        case .removalUnavailable:
            "This Sliccstart copy cannot be prepared for removal here. "
                + "It may be a development, missing, read-only, or uninstalled copy. Keep it, or manage that copy manually in Finder."
        }
    }
}

/// Native bundle-ID discovery and launch receipts, never process-name/PID guesses.
/// Removal deliberately ends at Finder selection, without self-quit or deletion.
actor SliccyAppRoute {
    struct Services {
        var discover: () async -> [URL] = {
            await MainActor.run { NSWorkspace.shared.urlsForApplications(withBundleIdentifier: "ai.sliccy.mac") }
        }
        var validate: (URL) async throws -> SliccyApplication = { url in
            let canonical = url.resolvingSymlinksInPath()
            guard SliccyApplicationValidator.isInstalledLocation(canonical),
                (try canonical.resourceValues(forKeys: [.volumeIsReadOnlyKey])).volumeIsReadOnly == false
            else { throw SliccyRouteError.unsuitableApp }
            return try await SliccyApplicationValidator.validate(canonical)
        }
        var exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
        var launch: (URL) async throws -> Bool = { url in
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            configuration.allowsRunningApplicationSubstitution = false
            let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            return !app.isTerminated && app.bundleIdentifier == "ai.sliccy.mac"
                && app.bundleURL?.resolvingSymlinksInPath() == url.resolvingSymlinksInPath()
        }
        var isRunning: (URL) async -> Bool = { url in
            await MainActor.run {
                NSWorkspace.shared.runningApplications.contains {
                    !$0.isTerminated && $0.bundleIdentifier == "ai.sliccy.mac"
                        && $0.bundleURL?.resolvingSymlinksInPath() == url.resolvingSymlinksInPath()
                }
            }
        }
        var removalContext: () -> SliccstartRemovalContext = SliccstartRemovalContext.live
        var validateOldApp: (URL) async throws -> Void = { url in
            let requirement = SliccyRelease.signingRequirement.replacingOccurrences(of: "ai.sliccy.mac", with: "com.slicc.sliccstart")
            try await SliccyInstallCommand.run("/usr/bin/codesign", arguments: ["--verify", "--deep", "--strict", "-R", requirement, url.path])
        }
        var reveal: (URL) async -> Bool = { url in
            await MainActor.run {
                NSWorkspace.shared.selectFile(url.path, inFileViewerRootedAtPath: url.deletingLastPathComponent().path)
            }
        }
    }

    private let services: Services
    init(services: Services = Services()) { self.services = services }

    func discover() async throws -> SliccyApplication? {
        var suitable: [SliccyApplication] = []
        var foundInvalid = false
        for url in await services.discover() where services.exists(url) {
            do { suitable.append(try await services.validate(url)) } catch { foundInvalid = true }
        }
        if let app = suitable.max(by: { $0.version.compare($1.version, options: .numeric) == .orderedAscending }) { return app }
        if foundInvalid { throw SliccyRouteError.unsuitableApp }
        return nil
    }

    func exists(_ url: URL) -> Bool { services.exists(url) }

    func validate(_ url: URL) async throws -> SliccyApplication { try await services.validate(url) }

    func open(_ url: URL) async throws -> SliccyApplication {
        let app = try await services.validate(url)
        try Task.checkCancellation()
        guard try await services.launch(app.url) else { throw SliccyRouteError.launchFailed }
        guard await services.isRunning(app.url) else { throw SliccyRouteError.launchFailed }
        return app
    }

    func revealOldApp(afterLaunching app: URL) async throws -> URL {
        let verified = try await services.validate(app)
        guard await services.isRunning(verified.url) else { throw SliccyRouteError.notRunning }
        let context = services.removalContext()
        guard context.canRevealForRemoval, context.url != verified.url else { throw SliccyRouteError.removalUnavailable }
        do { try await services.validateOldApp(context.url) } catch { throw SliccyRouteError.removalUnavailable }
        try Task.checkCancellation()
        _ = try await services.validate(verified.url)
        let latest = services.removalContext()
        guard latest.canRevealForRemoval, latest.url == context.url else { throw SliccyRouteError.removalUnavailable }
        // Recheck immediately before handing this exact running bundle to Finder.
        guard await services.isRunning(verified.url) else { throw SliccyRouteError.notRunning }
        guard await services.reveal(context.url) else { throw SliccyRouteError.revealFailed(context.url) }
        return context.url
    }
}
