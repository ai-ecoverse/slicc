import SwiftUI

struct ContentView: View {
    var body: some View {

        ChatView()
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
