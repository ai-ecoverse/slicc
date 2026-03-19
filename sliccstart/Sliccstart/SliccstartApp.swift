import SwiftUI

@main
struct SliccstartApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Sliccstart")
                .font(.title)
                .padding()
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 420, height: 600)
    }
}
