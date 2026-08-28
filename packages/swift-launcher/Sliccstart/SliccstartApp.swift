import AppKit
import AppUpdater
import Combine
import SliccTraySession
import SwiftOptel
import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "App")

/// Delegate that terminates all launched SLICC processes when the app quits.
/// Owns the SliccProcess instance so it stays alive for the entire app lifetime.
///
/// It is also the app's composition root: the window's ``LauncherModel`` is
/// built here, from the same long-lived collaborators the delegate already
/// owns, so `SliccstartApp` itself stays a thin `Scene` declaration.
///
/// When `sliccProcess.isPreparingForUpdate` is true (the user just clicked
/// "Restart to Update"), we instead persist the launch records and SIGUSR1
/// every slicc-server child so the browsers/Electron apps survive. The new
/// Sliccstart reattaches on next launch in `LauncherModel.initialize()`.
final class SliccstartAppDelegate: NSObject, NSApplicationDelegate {
    let sliccProcess: SliccProcess
    let sessionStore: TraySessionSyncStore
    let fileProviderCoordinator: FileProviderCoordinator
    let appUpdater: AppUpdater

    /// `@NSApplicationDelegateAdaptor` instantiates the delegate through the
    /// **Objective-C** runtime's `-init`. A Swift designated initializer whose
    /// parameters are all defaulted is callable as `init()` from Swift but
    /// does *not* vend that selector, so adding one below replaced the
    /// inherited `NSObject.init` with a trap and the app died on launch with
    /// "Use of unimplemented initializer 'init()'". Nothing in a unit test
    /// suite or a compile catches that — only running the app does.
    /// `AppDelegateLifecycleTests.testTheDelegateIsConstructibleFromTheObjCRuntime`
    /// is the regression.
    override convenience init() {
        self.init(sliccProcess: SliccProcess())
    }

    /// Everything defaulted, so a test can stand in for the collaborators and
    /// check what quitting actually does to the user's running browsers.
    init(
        sliccProcess: SliccProcess = SliccProcess(),
        sessionStore: TraySessionSyncStore = TraySessionSyncStore(),
        fileProviderCoordinator: FileProviderCoordinator = FileProviderCoordinator(),
        appUpdater: AppUpdater = AppUpdater(
            owner: "ai-ecoverse",
            repo: "slicc",
            releasePrefix: "Sliccstart",
            provider: TolerantGithubReleaseProvider(
                host: UpdateHostConfiguration.resolve(),
                releasePrefix: "Sliccstart"
            )
        )
    ) {
        self.sliccProcess = sliccProcess
        self.sessionStore = sessionStore
        self.fileProviderCoordinator = fileProviderCoordinator
        self.appUpdater = appUpdater
        super.init()
    }
    /// Feeds the Cones & Scoops widget. Dials the leader only when a widget is
    /// actually installed — see `WidgetTrayObserver`. `@MainActor` and lazy so
    /// the delegate's own (nonisolated) init does not have to build it.
    @MainActor lazy var widgetTrayObserver = WidgetTrayObserver()
    /// The window's behavior. Lazy for the same reason.
    @MainActor lazy var model = LauncherModel(
        process: sliccProcess,
        sessionStore: sessionStore,
        fileProviderCoordinator: fileProviderCoordinator,
        widgetTrayObserver: widgetTrayObserver,
        updateChecking: .live(appUpdater)
    )
    /// Created on the first incoming link (only reachable while Sliccstart is
    /// the default web browser, or the handler for an HTML document) and kept
    /// afterwards, so its queue survives a burst of clicks.
    @MainActor private var urlRouter: IncomingURLRouter?

    /// Links macOS routes to us because we hold the http/https handler role.
    /// Sliccstart shows no web content itself, so each one becomes a tab in
    /// the SLICC leader browser — started on demand when it isn't running.
    func application(_ application: NSApplication, open urls: [URL]) {
        log.info("application(open:): \(urls.count, privacy: .public) url(s)")
        let process = sliccProcess
        Task { @MainActor in
            let router = urlRouter ?? IncomingURLRouter(process: process)
            urlRouter = router
            await router.handle(urls)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if sliccProcess.isPreparingForUpdate {
            // Browsers survive the update and the tray stays live, so leave
            // this device's session advertised — the relaunched Sliccstart
            // republishes it after reattach.
            log.info("applicationWillTerminate: detaching for update")
            sliccProcess.detachAll()
            return
        }
        log.info("applicationWillTerminate: stopping all processes")
        sliccProcess.stopAll()
        // The leader is going away, so stop advertising it to other devices.
        sessionStore.withdrawLocalSessions()
        fileProviderCoordinator.withdrawOnQuit()
        MainActor.assumeIsolated { widgetTrayObserver.stop() }
    }
}

struct SliccstartApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: SliccstartAppDelegate

    private let optelAppID = Bundle.main.bundleIdentifier ?? "unknown.app"

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: appDelegate.model, appUpdater: appDelegate.appUpdater)
                .frame(width: 340)
                .optelAutoInstrument(appID: optelAppID)
        }
        .defaultSize(width: 340, height: 100)
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    appDelegate.model.checkForUpdates()
                }
            }
        }

        Settings {
            SettingsView(fileProviderCoordinator: appDelegate.fileProviderCoordinator)
        }
    }
}
