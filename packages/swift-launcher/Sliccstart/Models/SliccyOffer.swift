import AppKit
import Darwin
import Observation

/// An optional successor offer, independent of Sliccstart's updater and runtime.
@MainActor
@Observable
final class SliccyOffer {
    static let dismissalKey = "sliccySuccessorOfferDismissed"
    static let releasesURL = URL(string: "https://github.com/ai-ecoverse/sliccy-app/releases/latest")!
    static let requirements = "Requires macOS 27 or newer and Apple silicon."
    static let installation =
        "Download the DMG from the release page, open it, and drag Sliccy to Applications. Sliccstart stays installed and usable with its own updates."
    static let limitations =
        "Sliccy is a separate app. Settings are not imported. Features differ; "
        + "screen capture in Sliccy is currently disabled. Review the release notes before deciding."

    let isSupported: Bool
    private(set) var isDismissed: Bool
    private(set) var openFailed = false
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let openURL: (URL) -> Bool

    init(
        defaults: UserDefaults = .standard,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        isAppleSilicon: Bool = SliccyOffer.hostIsAppleSilicon,
        openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }
    ) {
        self.defaults = defaults
        self.openURL = openURL
        isSupported = osVersion.majorVersion >= 27 && isAppleSilicon
        isDismissed = defaults.bool(forKey: Self.dismissalKey)
    }

    var shouldShowBanner: Bool { isSupported && !isDismissed }

    func setDismissed(_ dismissed: Bool) {
        isDismissed = dismissed
        defaults.set(dismissed, forKey: Self.dismissalKey)
    }

    /// Only an explicit button action opens a page; no install, migration, or quit.
    func openReleases() {
        guard isSupported else { return }
        openFailed = !openURL(Self.releasesURL)
    }

    /// Detect the hardware, including an Intel build running under Rosetta.
    nonisolated static var hostIsAppleSilicon: Bool {
        var supported: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &supported, &size, nil, 0) == 0 && supported == 1
    }
}
