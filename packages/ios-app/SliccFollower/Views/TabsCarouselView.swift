import SliccTrayKit
import SwiftUI
import WebKit

















struct TabsCarouselView: View {
    @EnvironmentObject var appState: AppState
    
    @State private var editingAddressTabId: String?
    @State private var addressText = ""
    
    
    @State private var pendingAddressFocusTabId: String?
    
    
    
    @State private var tabSnapshots: [String: UIImage] = [:]
    @FocusState private var addressFocus: String?

    @Environment(\.palette) private var palette

    private var canControlTabs: Bool {
        appState.connectionState == .connected
    }

    private var viewingTarget: CDPTargetSummary? {
        guard let id = appState.browserViewingTabId else { return nil }
        return appState.cdpTargets.first { $0.id == id }
    }

    private var viewingComputer: ComputerDescriptor? {
        guard let id = appState.viewingComputerId else { return nil }
        return appState.computers.first { $0.id == id }
    }

    var body: some View {
        Group {
            if let computer = viewingComputer {
                ComputerLiveView(
                    computer: computer, frame: appState.liveFrame(forComputerId: computer.id))
            } else if let target = viewingTarget {
                browsingView(target)
            } else if appState.cdpTargets.isEmpty && appState.remoteTargets.isEmpty
                && appState.computers.isEmpty
            {
                emptyState
            } else {
                tabOverview
            }
        }
        .background(palette.canvas)
        .navigationTitle("Tabs")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: appState.cdpTargets) { targets in
            
            if let editing = editingAddressTabId, !targets.contains(where: { $0.id == editing }) {
                endAddressEditing()
            }
        }
    }

    

    
    @ViewBuilder
    private func browsingView(_ target: CDPTargetSummary) -> some View {
        ZStack(alignment: .bottom) {
            if let webView = appState.cdpWebView(for: target.id) {
                CDPTargetWebView(webView: webView)
            } else {
                ProgressView("Tab unavailable")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            bottomBar(target)
        }
        .onAppear {
            if pendingAddressFocusTabId == target.id {
                pendingAddressFocusTabId = nil
                beginEditingAddress(target)
            }
        }
    }

    @ViewBuilder
    private func bottomBar(_ target: CDPTargetSummary) -> some View {
        HStack(spacing: 10) {
            if editingAddressTabId == target.id {
                addressField(target)
            } else {
                circleBarButton("arrow.clockwise", label: "Reload tab") {
                    appState.cdpBridgeReload(target.id)
                }
                addressPill(target)
                circleBarButton(
                    "square.on.square", label: "Show all tabs",
                    identifier: "browser-show-tabs"
                ) {
                    leaveBrowsing(target)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    
    
    private func addressPill(_ target: CDPTargetSummary) -> some View {
        Button {
            beginEditingAddress(target)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "globe")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text(Self.pillLabel(for: target.url))
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .modifier(GlassCapsuleButtonStyle())
        .accessibilityLabel("Address: \(Self.pillLabel(for: target.url))")
        .accessibilityHint("Edit address")
        .accessibilityIdentifier("browser-address-display")
    }

    @ViewBuilder
    private func addressField(_ target: CDPTargetSummary) -> some View {
        TextField("Enter website address", text: $addressText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .keyboardType(.URL)
            .submitLabel(.go)
            .focused($addressFocus, equals: target.id)
            .onSubmit { commitAddress(for: target) }
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .modifier(GlassCapsuleBackground())
            .accessibilityIdentifier("browser-address-field")
        Button("Cancel") { endAddressEditing() }
            .font(.system(size: 14))
            .foregroundStyle(palette.ink.opacity(0.7))
            .accessibilityIdentifier("browser-address-cancel")
    }

    private func circleBarButton(
        _ systemImage: String, label: String, identifier: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .frame(width: 44, height: 44)
        }
        .modifier(GlassCircleButtonStyle())
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier ?? systemImage)
    }

    
    
    private func leaveBrowsing(_ target: CDPTargetSummary) {
        if let webView = appState.cdpWebView(for: target.id) {
            webView.takeSnapshot(with: nil) { image, _ in
                if let image { tabSnapshots[target.id] = image }
            }
        }
        endAddressEditing()
        appState.browserViewingTabId = nil
    }

    

    
    
    private var tabOverview: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())],
                spacing: 12
            ) {
                if !appState.cdpTargets.isEmpty {
                    Section {
                        ForEach(appState.cdpTargets) { target in
                            LocalTabCard(
                                target: target,
                                snapshot: tabSnapshots[target.id],
                                canControl: canControlTabs,
                                onOpen: { appState.browserViewingTabId = target.id },
                                onClose: { appState.cdpCloseTab(target.id) }
                            )
                        }
                    } header: {
                        gridHeader("On this device")
                    }
                }
                if !appState.remoteTargets.isEmpty {
                    Section {
                        ForEach(appState.remoteTargets, id: \.targetId) { target in
                            RemoteTabCard(target: target) {
                                openRemoteTabLocally(target)
                            }
                        }
                    } header: {
                        gridHeader("Elsewhere in the tray")
                    }
                }
                if !appState.computers.isEmpty {
                    Section {
                        ForEach(appState.computers) { computer in
                            ComputerCard(
                                computer: computer,
                                frame: appState.liveFrame(forComputerId: computer.id)
                            ) {
                                appState.viewingComputerId = computer.id
                            }
                        }
                    } header: {
                        gridHeader("Computers")
                    }
                }
            }
            .padding(12)
        }
        .overlay(alignment: .bottomTrailing) {
            floatingNewTabButton
        }
    }

    private func gridHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.inkSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    
    
    private var floatingNewTabButton: some View {
        Button {
            openNewTab()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 52, height: 52)
        }
        .modifier(GlassCircleButtonStyle())
        .disabled(!canControlTabs)
        .accessibilityLabel("Open new tab")
        .accessibilityIdentifier("browser-open-new-tab")
        .padding(20)
    }

    
    
    private func openNewTab() {
        let id = appState.cdpOpenTab()
        appState.browserViewingTabId = id
        pendingAddressFocusTabId = id
    }

    
    
    
    
    
    
    
    private func openRemoteTabLocally(_ target: TrayTargetEntry) {
        guard canControlTabs, !target.url.isEmpty else { return }
        if appState.supportsTabTeleport, appState.requestTabTeleport(targetId: target.targetId) {
            return
        }
        let id = appState.cdpOpenTab(url: target.url)
        appState.browserViewingTabId = id
    }

    

    private func beginEditingAddress(_ target: CDPTargetSummary) {
        addressText = target.url == "about:blank" ? "" : target.url
        editingAddressTabId = target.id
        addressFocus = target.id
    }

    private func commitAddress(for target: CDPTargetSummary) {
        appState.cdpNavigate(target.id, to: Self.normalizeUrl(addressText))
        endAddressEditing()
    }

    private func endAddressEditing() {
        editingAddressTabId = nil
        addressFocus = nil
    }

    
    
    static func normalizeUrl(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "https://" || trimmed == "http://" {
            return "about:blank"
        }
        if trimmed.contains("://") || trimmed.hasPrefix("about:") || trimmed.hasPrefix("data:") {
            return trimmed
        }
        return "https://\(trimmed)"
    }

    
    static func pillLabel(for url: String) -> String {
        url == "about:blank" ? "New tab" : RemoteTabCard.displayHost(url)
    }

    

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "rectangle.stack.badge.plus")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No browser tabs")
                .font(.headline)
            Text(
                canControlTabs
                    ? "Tabs you open live on this device — and the leader can drive them over the CDP bridge."
                    : "Connect to a leader (Settings → Join link) to host browser tabs here."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            
            
            
            Button {
                openNewTab()
            } label: {
                Label("Open new tab", systemImage: "plus")
            }
            .modifier(ProminentGlassButtonStyle())
            .disabled(!canControlTabs)
            .accessibilityLabel("Open new tab")
            .accessibilityIdentifier("browser-open-new-tab")
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}






private struct LocalTabCard: View {
    let target: CDPTargetSummary
    let snapshot: UIImage?
    let canControl: Bool
    let onOpen: () -> Void
    let onClose: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .bottom) {
            thumbnail
            caption
        }
        .frame(height: 156)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(palette.line, lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { onOpen() }
        .accessibilityAction(named: "Open tab") { onOpen() }
        .overlay(alignment: .topTrailing) { closeButton }
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            Rectangle().fill(palette.field)
            if let snapshot {
                
                
                Color.clear
                    .overlay(
                        Image(uiImage: snapshot)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    )
                    .clipped()
            } else {
                Image(systemName: "globe")
                    .font(.system(size: 28))
                    .foregroundStyle(palette.inkTertiary)
                    .padding(.bottom, 40)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(target.title.isEmpty ? "Untitled" : target.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .accessibilityIdentifier("browser-local-tab-title")
            Text(TabsCarouselView.pillLabel(for: target.url))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial)
    }

    private var closeButton: some View {
        Button(role: .destructive) {
            onClose()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .bold))
                .frame(width: 26, height: 26)
                .background(.regularMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canControl)
        .accessibilityLabel("Close tab")
        .accessibilityIdentifier("browser-tab-close")
        .padding(6)
    }
}





private struct GlassCircleButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
        } else {
            content
                .buttonStyle(.plain)
                .background(.regularMaterial, in: Circle())
        }
    }
}

private struct GlassCapsuleButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
        } else {
            content
                .buttonStyle(.plain)
                .background(.regularMaterial, in: Capsule())
        }
    }
}


private struct GlassCapsuleBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}

private struct ProminentGlassButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}





struct CDPTargetWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        attach(webView, to: container)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        
        if webView.superview !== uiView {
            attach(webView, to: uiView)
        }
    }

    private func attach(_ webView: WKWebView, to container: UIView) {
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
    }
}
