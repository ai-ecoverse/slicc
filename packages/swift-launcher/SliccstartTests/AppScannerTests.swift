import XCTest

@testable import Sliccstart

final class AppScannerTests: XCTestCase {
    func testKnownChromiumBrowserBundleIdsMatchCanonicalSet() {
        let knownBundleIds = Set(AppTarget.knownChromiumBrowsers.map(\.bundleId))

        let expectedBundleIds: Set<String> = [
            "com.google.Chrome",
            "com.google.Chrome.beta",
            "com.google.Chrome.dev",
            "com.google.Chrome.canary",
            "com.google.chrome.for.testing",
            "com.brave.Browser",
            "com.brave.Browser.beta",
            "com.brave.Browser.nightly",
            "com.microsoft.edgemac",
            "com.microsoft.edgemac.Beta",
            "com.microsoft.edgemac.Dev",
            "com.microsoft.edgemac.Canary",
            "com.vivaldi.Vivaldi",
            "com.vivaldi.Vivaldi.snapshot",
            "com.operasoftware.Opera",
            "company.thebrowser.Browser",
            "company.thebrowser.dia",
            "com.openai.atlas",
            "org.chromium.Chromium",
        ]

        XCTAssertEqual(knownBundleIds, expectedBundleIds)
    }

    func testKnownTerminalBundleIdsMatchCanonicalSet() {
        let knownBundleIds = Set(AppTarget.knownTerminals.map(\.bundleId))

        let expectedBundleIds: Set<String> = [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.mitchellh.ghostty",
            "com.github.wez.wezterm",
            "net.kovidgoyal.kitty",
            "org.alacritty",
        ]

        XCTAssertEqual(knownBundleIds, expectedBundleIds)
    }

    func testKnownElectronAppsIncludeSignalWithRealBundleId() {

        let signal = AppTarget.knownElectronApps.first { $0.name == "Signal" }
        XCTAssertEqual(signal?.bundleId, "org.whispersystems.signal-desktop")
        XCTAssertFalse(
            AppTarget.knownElectronApps.contains { $0.bundleId == "org.signal.Signal" },
            "stale Signal bundle id `org.signal.Signal` never resolves an installed app"
        )
    }

    func testKnownElectronAppBundleIdsAreWellFormedAndUnique() {
        let ids = AppTarget.knownElectronApps.map(\.bundleId)

        for id in ids {
            XCTAssertFalse(id.isEmpty, "empty bundle id in knownElectronApps")
            XCTAssertTrue(id.contains("."), "bundle id `\(id)` is not reverse-DNS")
            XCTAssertFalse(
                id.contains(where: \.isWhitespace), "bundle id `\(id)` contains whitespace")
        }
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate bundle id in knownElectronApps")
    }

    func testIsChromiumBrowserMatchesExpandedBrowserList() {
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "company.thebrowser.dia"))
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "com.openai.atlas"))
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "company.thebrowser.Browser"))
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "com.google.chrome.for.testing"))
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "com.microsoft.edgemac.Dev"))
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "com.brave.Browser.nightly"))
        XCTAssertFalse(AppScanner.isChromiumBrowser(bundleId: "com.openai.chat"))
    }
}
