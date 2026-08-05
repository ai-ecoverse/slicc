import SwiftUI

@main
struct SliccFollowerApp: App {
    @StateObject private var appState = AppState()
    /// The process-wide inbound funnel — App Intents enqueue into the same
    /// instance, so the scene must observe the shared one (#1918).
    @StateObject private var inboundActions = InboundActionCoordinator.shared

    var body: some Scene {
        WindowGroup {
            rootView
                .onOpenURL { url in
                    // Untrusted input: the coordinator validates and the
                    // shell asks before anything opens. A rejected link is
                    // dropped here — there is nothing useful to render for
                    // a URL we refuse to parse.
                    _ = inboundActions.receive(deepLink: url)
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
