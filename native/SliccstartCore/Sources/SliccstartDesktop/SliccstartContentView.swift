import AppKit
import SliccstartCore
import SwiftUI
import UniformTypeIdentifiers

public struct SliccstartContentView: View {
  @ObservedObject private var viewModel: SliccstartAppViewModel
  @State private var draggedBundlePath: String?

  public init(viewModel: SliccstartAppViewModel) {
    self.viewModel = viewModel
  }

  public var body: some View {
    VStack(spacing: 0) {
      if viewModel.apps.isEmpty {
        VStack(spacing: 8) {
          Image(systemName: "app.badge")
            .font(.system(size: 28))
            .foregroundStyle(.secondary)
          Text("No compatible apps found")
            .font(.headline)
          Text("Use + to add a Chromium-family browser or Electron app bundle.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List(viewModel.apps, id: \.bundlePath) { app in
          SliccstartAppRow(app: app, onDoubleClick: {
            viewModel.launch(app)
          })
          .onDrag {
            draggedBundlePath = app.bundlePath
            return NSItemProvider(object: app.bundlePath as NSString)
          }
          .onDrop(of: [.text], delegate: SliccstartAppDropDelegate(
            targetBundlePath: app.bundlePath,
            draggedBundlePath: $draggedBundlePath,
            viewModel: viewModel
          ))
          .background(DoubleClickDetector(onDoubleClick: {
            viewModel.launch(app)
          }))
        }
        .listStyle(.plain)
      }
    }
    .toolbar {
      ToolbarItem {
        Button(action: chooseAppBundle) {
          Label("Add App", systemImage: "plus")
        }
      }
    }
    .onAppear {
      viewModel.performInitialLoadIfNeeded()
    }
    .alert("Sliccstart", isPresented: errorBinding) {
      Button("OK", role: .cancel) {
        viewModel.clearError()
      }
    } message: {
      Text(viewModel.errorMessage ?? "")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { viewModel.errorMessage != nil },
      set: { isPresented in
        if !isPresented {
          viewModel.clearError()
        }
      }
    )
  }

  private func chooseAppBundle() {
    let panel = NSOpenPanel()
    panel.prompt = "Add"
    panel.message = "Choose an extra .app bundle to include in Sliccstart."
    panel.allowsMultipleSelection = false
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowedContentTypes = [.applicationBundle]

    if panel.runModal() == .OK, let url = panel.url {
      viewModel.addApp(bundlePath: url.path)
    }
  }
}

public struct SliccstartSettingsView: View {
  @ObservedObject private var viewModel: SliccstartAppViewModel

  public init(viewModel: SliccstartAppViewModel) {
    self.viewModel = viewModel
  }

  public var body: some View {
    Form {
      Section {
        Toggle(
          "Auto-launch preferred browser",
          isOn: Binding(
            get: { viewModel.autoLaunchPreferredBrowser },
            set: { viewModel.setAutoLaunchPreferredBrowser($0) }
          )
        )
      } footer: {
        Text("When enabled, startup launches the first compatible app in your saved order.")
      }
    }
    .formStyle(.grouped)
    .frame(width: 420)
  }
}

private struct SliccstartAppRow: View {
  let app: SliccDiscoveredApp
  let onDoubleClick: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Image(nsImage: appIcon)
        .resizable()
        .frame(width: 32, height: 32)

      VStack(alignment: .leading, spacing: 2) {
        Text(app.displayName)
          .font(.body)

        Text(subtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Spacer()

      if !app.isLaunchable {
        Text("Incompatible")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .contentShape(Rectangle())
    .opacity(app.isLaunchable ? 1 : 0.6)
  }

  private var subtitle: String {
    if app.isLaunchable {
      return app.type == .browser ? "Compatible browser" : "Compatible Electron app"
    }

    return app.compatibility.reason ?? "Not compatible with current SLICC launch semantics."
  }

  private var appIcon: NSImage {
    let icon = NSWorkspace.shared.icon(forFile: app.bundlePath)
    icon.size = NSSize(width: 32, height: 32)
    return icon
  }
}

private struct SliccstartAppDropDelegate: DropDelegate {
  let targetBundlePath: String?
  @Binding var draggedBundlePath: String?
  let viewModel: SliccstartAppViewModel

  func dropEntered(info: DropInfo) {
    guard let draggedBundlePath, draggedBundlePath != targetBundlePath else { return }
    viewModel.move(bundlePath: draggedBundlePath, before: targetBundlePath)
  }

  func performDrop(info: DropInfo) -> Bool {
    draggedBundlePath = nil
    return true
  }
}

// MARK: - Double-Click Detection

private struct DoubleClickDetector: NSViewRepresentable {
  let onDoubleClick: () -> Void

  func makeNSView(context: Context) -> NSView {
    let view = DoubleClickView()
    view.onDoubleClick = onDoubleClick
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {}
}

private class DoubleClickView: NSView {
  var onDoubleClick: (() -> Void)?

  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 {
      onDoubleClick?()
    }
    super.mouseDown(with: event)
  }
}