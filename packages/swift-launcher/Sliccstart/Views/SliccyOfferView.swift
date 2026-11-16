import SwiftUI

struct SliccyOfferBanner: View {
    var offer: SliccyOffer
    var onLearnMore: () -> Void = {}

    var body: some View {
        if offer.shouldShowBanner {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(offer.installedURL == nil ? "Try Sliccy, Sliccstart’s successor" : "Did you mean Sliccy?")
                        .font(.callout.weight(.semibold))
                    Spacer(minLength: 0)
                    Button {
                        offer.setDismissed(true)
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Dismiss Sliccy offer")
                    .help("Hide this offer. Find it again in Settings → Sliccy.")
                }
                Text(offer.installedURL == nil ? "Optional separate installation. Keep using Sliccstart." : "A verified Sliccy app is already installed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    if offer.installedURL != nil {
                        Button(offer.isLaunching ? "Opening…" : "Open Sliccy") { offer.openInstalledApp() }
                            .disabled(offer.isLaunching)
                            .controlSize(.small)
                    }
                    Button(offer.installedURL == nil ? "Learn More…" : "Options…", action: onLearnMore)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                if offer.installedURL != nil {
                    Button("Keep Using Sliccstart") { offer.setDismissed(true) }
                        .buttonStyle(.borderless).font(.caption)
                }
            }
            .padding(12)
            Divider()
        }
    }
}

/// Also available in Settings after the main-window offer has been dismissed.
struct SliccyOfferView: View {
    @Bindable var offer: SliccyOffer
    @State private var confirmInstallation = false
    @State private var confirmRemoval = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(offer.installedURL == nil ? "Sliccy" : "Did you mean Sliccy?")
                .font(.title2.weight(.semibold))
            Text("The native Mac successor to Sliccstart. Trying it is optional.")
            Text(SliccyOffer.requirements)
                .fontWeight(.medium)
            if offer.installedURL == nil {
                Text(SliccyOffer.installation)
            } else {
                Text("Sliccy is already installed. Open it to continue there. You can keep using Sliccstart, or choose optional removal afterward.")
            }
            Text(SliccyOffer.limitations)
                .foregroundStyle(.secondary)
            if offer.isSupported {
                if let installed = offer.installedURL {
                    Text("Verified Sliccy \(offer.installedVersion ?? "") at \(installed.path).")
                        .font(.caption).textSelection(.enabled)
                    Button(offer.isLaunching ? "Opening…" : "Open Sliccy") { offer.openInstalledApp() }
                        .buttonStyle(.bordered).disabled(offer.isLaunching)
                    if offer.launchSucceeded {
                        Button("Remove Sliccstart…") { confirmRemoval = true }
                        Text("Removal is optional. Finder will select this copy; you choose whether to quit it and move it to Trash.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button("Keep Using Sliccstart") { offer.setDismissed(true) }
                        .buttonStyle(.borderless)
                } else if let status = offer.installStatus {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(status).font(.caption)
                        Button("Cancel") { offer.cancelInstallation() }
                    }
                } else if offer.isCheckingInstalled {
                    Text("Checking installed Sliccy apps…").font(.caption)
                } else {
                    Button("Download and Install Sliccy \(SliccyRelease.version)…") { confirmInstallation = true }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("sliccy-install")
                        .disabled(offer.discoveryError != nil)
                }
                if let error = offer.discoveryError ?? offer.routeError {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Button("Check Again") { Task { await offer.refreshInstalledApp() } }
                }
                if let instruction = offer.removalInstruction {
                    Text(instruction).font(.caption).textSelection(.enabled)
                }
                if let error = offer.installError {
                    Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
                Button("Release Notes…") { offer.openReleases() }
                    .buttonStyle(.borderless)
                if offer.openFailed {
                    Text("Could not open Sliccy or its release notes. Try again.")
                        .font(.caption)
                }
                Toggle(
                    "Show offer in the main window",
                    isOn: Binding(
                        get: { !offer.isDismissed },
                        set: { offer.setDismissed(!$0) }
                    )
                )
            } else {
                Text("This Mac does not meet Sliccy’s requirements. You can keep using and updating Sliccstart.")
                    .fontWeight(.medium)
            }
        }
        .alert("Install Sliccy \(SliccyRelease.version)?", isPresented: $confirmInstallation) {
            Button("Cancel", role: .cancel) {}
            Button("Download and Install") { offer.startInstallation() }
        } message: {
            Text(
                "Download the verified release from GitHub and install it in ~/Applications? "
                    + "Existing apps will not be replaced. Settings are not imported. Sliccstart will keep running."
            )
        }
        .alert("Remove Sliccstart?", isPresented: $confirmRemoval) {
            Button("Cancel", role: .cancel) {}
            Button("Reveal Sliccstart in Finder") { Task { await offer.revealSliccstartForRemoval() } }
        } message: {
            Text(
                "Sliccy must still be running. Finder will select only this installed Sliccstart app. "
                    + "Quit Sliccstart yourself and move that app to Trash if you choose. "
                    + "No settings or profiles are removed, and no default-browser setting is changed."
            )
        }
        .padding(20)
        .frame(width: 420, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}
