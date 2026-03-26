import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            ChatView()
                .navigationTitle("SLICC")
                .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}

