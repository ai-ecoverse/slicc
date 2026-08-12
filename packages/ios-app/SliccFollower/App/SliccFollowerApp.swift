import SwiftUI

@main
struct SliccFollowerApp: App {
    @StateObject private var appState = AppState()
    /// The process-wide inbound funnel — App Intents enqueue into the same
    /// instance, so the scene must observe the shared one (#1918).
    @StateObject private var inboundActions = InboundActionCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            rootView
                .onOpenURL { url in
                    if appState.handleOpenCallback(url) { return }
                    // Untrusted input: the coordinator validates and the
                    // shell asks before anything opens. A rejected link is
                    // dropped here — there is nothing useful to render for
                    // a URL we refuse to parse.
                    _ = inboundActions.receive(deepLink: url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    // Universal links land as a browsing activity, not
                    // onOpenURL. Same funnel, same confirmation policy.
                    if let url = activity.webpageURL {
                        _ = inboundActions.receive(appLink: url)
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // The Share extension cannot foreground the app; whatever it
            // parked in the App Group inbox surfaces as confirmation
            // cards the next time the user opens Sliccy (#1918).
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
