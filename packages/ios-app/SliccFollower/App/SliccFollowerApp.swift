import SwiftUI

@main
struct SliccFollowerApp: App {
    
    
    @UIApplicationDelegateAdaptor(SliccAppDelegate.self) private var appDelegate
    @StateObject private var appState = AppState()
    
    
    @StateObject private var inboundActions = InboundActionCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            rootView
                .onOpenURL { url in
                    if appState.handleOpenCallback(url) { return }
                    
                    
                    
                    
                    _ = inboundActions.receive(deepLink: url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    
                    
                    if let url = activity.webpageURL {
                        _ = inboundActions.receive(appLink: url)
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            
            
            
            if phase == .active {
                inboundActions.drainShareInbox()
            }
        }
    }

    @ViewBuilder
    private var rootView: some View {
        #if DEBUG
            if let variant = UITestHooks.avatarFixtureVariant {
                AvatarIsolationView(variant: variant)
            } else {
                ContentView()
                    .environmentObject(appState)
                    .environmentObject(inboundActions)
            }
        #else
            ContentView()
                .environmentObject(appState)
                .environmentObject(inboundActions)
        #endif
    }
}
