import SwiftUI

@main
struct SliccFollowerApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            rootView
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
            }
        #else
            ContentView()
                .environmentObject(appState)
        #endif
    }
}
