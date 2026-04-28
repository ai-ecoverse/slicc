import SwiftUI

struct ContentView: View {
    var body: some View {
        // ChatView is itself a NavigationSplitView; no wrapping NavigationStack
        // is needed (and would break the iPad sidebar pattern).
        ChatView()
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}

