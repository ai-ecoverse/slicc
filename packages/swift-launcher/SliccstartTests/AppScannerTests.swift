import XCTest
@testable import Sliccstart

final class AppScannerTests: XCTestCase {
    func testKnownChromiumBrowserBundleIdsIncludeSupportedChannels() {
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
