import SwiftUI

struct SliccyOfferBanner: View {
    var offer: SliccyOffer
    var onLearnMore: () -> Void = {}

    var body: some View {
        if offer.shouldShowBanner {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Try Sliccy, Sliccstart’s successor")
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
                Text("Optional separate installation. Keep using Sliccstart.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Learn More…", action: onLearnMore)
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
            .padding(12)
            Divider()
        }
    }
}

/// Also available in Settings after the main-window offer has been dismissed.
struct SliccyOfferView: View {
    @Bindable var offer: SliccyOffer

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sliccy")
                .font(.title2.weight(.semibold))
            Text("The native Mac successor to Sliccstart. Trying it is optional.")
            Text(SliccyOffer.requirements)
                .fontWeight(.medium)
            Text(SliccyOffer.installation)
            Text(SliccyOffer.limitations)
                .foregroundStyle(.secondary)
            if offer.isSupported {
                Button("View Releases and Download…") { offer.openReleases() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("sliccy-releases")
                Text("Opens ai-ecoverse/sliccy-app on GitHub in your browser.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if offer.openFailed {
                    Text("Could not open the release page. Try again, or visit \(SliccyOffer.releasesURL.absoluteString).")
                        .font(.caption)
                        .textSelection(.enabled)
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
        .padding(20)
        .frame(width: 420, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}
