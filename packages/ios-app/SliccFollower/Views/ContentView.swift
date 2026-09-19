import SwiftUI

struct ContentView: View {
    var body: some View {
        // ChatView is itself a NavigationSplitView; no wrapping NavigationStack
        // is needed (and would break the iPad sidebar pattern).
        #if DEBUG
            if let width = UITestHooks.shellWidthOverride {
                ChatView()
                    .frame(width: width)
                    .frame(maxWidth: .infinity)
                    .environment(\.horizontalSizeClass, .compact)
            } else {
                ChatView()
            }
        #else
            ChatView()
        #endif
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
