import AppKit
import AppUpdater
import Combine
import SliccTraySession
import SwiftOptel
import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "App")












final class SliccstartAppDelegate: NSObject, NSApplicationDelegate {
    let sliccProcess: SliccProcess
    let sessionStore: TraySessionSyncStore
    let fileProviderCoordinator: FileProviderCoordinator
    let appUpdater: AppUpdater

    
    
    
    
    
    
    
    
    
    override convenience init() {
        self.init(sliccProcess: SliccProcess())
    }

    
    
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
    
    
    
    @MainActor lazy var widgetTrayObserver = WidgetTrayObserver()
    
    @MainActor lazy var model = LauncherModel(
        process: sliccProcess,
        sessionStore: sessionStore,
        fileProviderCoordinator: fileProviderCoordinator,
        widgetTrayObserver: widgetTrayObserver,
        updateChecking: .live(appUpdater)
    )
    
    
    
    @MainActor private var urlRouter: IncomingURLRouter?

    
    
    
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
            
            
            
            log.info("applicationWillTerminate: detaching for update")
            sliccProcess.detachAll()
            return
        }
        log.info("applicationWillTerminate: stopping all processes")
        sliccProcess.stopAll()
        
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
