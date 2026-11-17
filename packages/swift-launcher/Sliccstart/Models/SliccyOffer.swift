import AppKit
import Darwin
import Observation

/// An optional successor offer, independent of Sliccstart's updater and runtime.
@MainActor
@Observable
final class SliccyOffer {
    static let dismissalKey = "sliccySuccessorOfferDismissed"
    static let releasesURL = SliccyRelease.notesURL
    static let requirements = "Requires macOS \(SliccyRelease.minimumOSMajor) or newer and Apple silicon."
    static let installation =
        "Download and install Sliccy \(SliccyRelease.version) from GitHub into ~/Applications. The signed app is verified before installation. "
        + "Sliccstart stays installed and usable with its own updates."
    static let limitations =
        "Sliccy is a separate app. Settings are not imported. Features differ; "
        + "screen capture in Sliccy is currently disabled. Review the release notes before deciding."

    let isSupported: Bool
    private(set) var isDismissed: Bool
    private(set) var openFailed = false
    private(set) var installStatus: String?
    private(set) var installError: String?
    private(set) var installedURL: URL?
    private(set) var installedVersion: String?
    private(set) var discoveryError: String?
    private(set) var routeError: String?
    private(set) var isCheckingInstalled = false
    private(set) var isLaunching = false
    private(set) var launchSucceeded = false
    private(set) var removalInstruction: String?
    @ObservationIgnored private let appRoute: SliccyAppRoute
    @ObservationIgnored private var installTask: Task<Void, Never>?
    typealias InstallAction = (@escaping @Sendable (String) async -> Void) async throws -> URL
    @ObservationIgnored private let install: InstallAction
    @ObservationIgnored private let onInstallError: (Error) -> Void
    @ObservationIgnored private let onRouteError: (Error) -> Void
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let openURL: (URL) -> Bool

    init(
        defaults: UserDefaults = .standard,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        isAppleSilicon: Bool = SliccyOffer.hostIsAppleSilicon,
        openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) },
        appRoute: SliccyAppRoute = SliccyAppRoute(),
        onRouteError: @escaping (Error) -> Void = { _ in },
        onInstallError: @escaping (Error) -> Void = { _ in },
        install: @escaping InstallAction = { try await SliccyInstaller().install(progress: $0) }
    ) {
        self.defaults = defaults
        self.openURL = openURL
        self.install = install
        self.onInstallError = onInstallError
        self.appRoute = appRoute
        self.onRouteError = onRouteError
        isSupported = osVersion.majorVersion >= SliccyRelease.minimumOSMajor && isAppleSilicon
        isDismissed = defaults.bool(forKey: Self.dismissalKey)
    }

    var shouldShowBanner: Bool { isSupported && !isDismissed }

    func setDismissed(_ dismissed: Bool) {
        isDismissed = dismissed
        defaults.set(dismissed, forKey: Self.dismissalKey)
    }

    var isInstalling: Bool { installStatus != nil }

    /// Called only after explicit install confirmation. Keep the task here so
    /// sheet closure does not abandon a download and cancellation is shared.
    @discardableResult
    func startInstallation() -> Task<Void, Never>? {
        guard isSupported, !isInstalling, !isCheckingInstalled, discoveryError == nil, installedURL == nil else { return nil }
        installError = nil
        installStatus = "Preparing installation…"
        let action = install
        let task = Task { [weak self] in
            defer {
                self?.installStatus = nil
                self?.installTask = nil
            }
            do {
                try Task.checkCancellation()
                let url = try await action { [weak self] status in
                    await self?.updateProgress(status)
                }
                self?.installedURL = url
                self?.installedVersion = SliccyRelease.version
                self?.setDismissed(true)
            } catch is CancellationError {
                // Cancelled before publishing: retry stays available.
            } catch {
                self?.installError = error.localizedDescription
                self?.onInstallError(error)
            }
        }
        installTask = task
        return task
    }

    private func updateProgress(_ status: String) { installStatus = status }

    func cancelInstallation() {
        guard isInstalling else { return }
        installStatus = "Cancelling…"
        installTask?.cancel()
    }

    func refreshInstalledApp() async {
        guard isSupported, !isInstalling, !isLaunching, !isCheckingInstalled else { return }
        isCheckingInstalled = true
        defer { isCheckingInstalled = false }
        do {
            let discovered = try await appRoute.discover()
            let app: SliccyApplication?
            if let discovered {
                app = discovered
            } else if let installedURL, await appRoute.exists(installedURL) {
                app = try await appRoute.validate(installedURL)
            } else {
                app = nil
            }
            if app?.url != installedURL {
                launchSucceeded = false
                removalInstruction = nil
            }
            installedURL = app?.url
            installedVersion = app?.version
            discoveryError = nil
        } catch {
            installedURL = nil
            installedVersion = nil
            launchSucceeded = false
            discoveryError = SliccyRouteError.unsuitableApp.localizedDescription
        }
    }

    @discardableResult
    func openInstalledApp() -> Task<Void, Never>? {
        guard isSupported, !isLaunching, let installedURL else { return nil }
        isLaunching = true
        launchSucceeded = false
        removalInstruction = nil
        routeError = nil
        let route = appRoute
        return Task { [weak self] in
            defer { self?.isLaunching = false }
            do {
                let app = try await route.open(installedURL)
                self?.installedURL = app.url
                self?.installedVersion = app.version
                self?.launchSucceeded = true
            } catch is CancellationError {
            } catch {
                self?.routeError = error.localizedDescription
                self?.onRouteError(error)
            }
        }
    }

    /// Called only after a separate removal confirmation. Finder owns Trash;
    /// this flow never terminates either app or removes any files itself.
    func revealSliccstartForRemoval() async {
        guard isSupported, launchSucceeded, let installedURL else {
            routeError = SliccyRouteError.notRunning.localizedDescription
            return
        }
        routeError = nil
        do {
            let oldApp = try await appRoute.revealOldApp(afterLaunching: installedURL)
            removalInstruction =
                "Finder selected \(oldApp.path). Quit Sliccstart yourself, then move only that selected app to Trash. "
                + "Settings and profiles remain. Default-browser settings are unchanged; choose your preferred default before removing Sliccstart."
        } catch {
            routeError = error.localizedDescription
            onRouteError(error)
        }
    }

    /// Release notes remain an optional secondary browser action.
    func openReleases() {
        guard isSupported else { return }
        let notes = installedVersion.flatMap { URL(string: "https://github.com/ai-ecoverse/sliccy-app/releases/tag/v\($0)") } ?? Self.releasesURL
        openFailed = !openURL(notes)
    }

    /// Detect the hardware, including an Intel build running under Rosetta.
    nonisolated static var hostIsAppleSilicon: Bool {
        var supported: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &supported, &size, nil, 0) == 0 && supported == 1
    }
}
