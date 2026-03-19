import SliccstartDesktop
import SwiftUI

@main
struct SliccstartApp: App {
  @StateObject private var viewModel = SliccstartAppViewModel()

  var body: some Scene {
    WindowGroup("Sliccstart") {
      SliccstartContentView(viewModel: viewModel)
        .frame(minWidth: 480, minHeight: 400)
    }
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)

    Settings {
      SliccstartSettingsView(viewModel: viewModel)
    }
  }
}