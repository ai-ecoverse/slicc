import SwiftUI

struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack {
            Text("SLICC Follower")
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("Connection: \(appState.connectionState.rawValue)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}

