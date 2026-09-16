import XCTest

@testable import Sliccstart

final class DefaultBrowserRegistrationTests: XCTestCase {
    private let bundleURL = URL(fileURLWithPath: "/Applications/Sliccstart.app", isDirectory: true)

    func testClaimsBothWebSchemes() {

        XCTAssertEqual(DefaultBrowserRegistration.handledSchemes, ["http", "https"])
    }

    func testMatchesIgnoresTrailingSlashDifferences() {

        XCTAssertTrue(
            DefaultBrowserRegistration.matches(
                handlerURL: URL(fileURLWithPath: "/Applications/Sliccstart.app"),
                bundleURL: bundleURL
            )
        )
    }

    func testMatchesResolvesRelativePathComponents() {
        XCTAssertTrue(
            DefaultBrowserRegistration.matches(
                handlerURL: URL(fileURLWithPath: "/Applications/./Sliccstart.app", isDirectory: true),
                bundleURL: bundleURL
            )
        )
    }

    func testDoesNotMatchAnotherBrowser() {
        XCTAssertFalse(
            DefaultBrowserRegistration.matches(
                handlerURL: URL(fileURLWithPath: "/Applications/Google Chrome.app", isDirectory: true),
                bundleURL: bundleURL
            )
        )
    }

    func testNoHandlerIsNotDefault() {
        XCTAssertFalse(DefaultBrowserRegistration.matches(handlerURL: nil, bundleURL: bundleURL))
    }

    func testProbeURLIsAWebURL() {
        XCTAssertEqual(DefaultBrowserRegistration.probeURL.scheme, "https")
    }

    func testIsDefaultAsksLaunchServicesForTheWebHandler() {
        let system = SystemStub(handler: bundleURL)

        XCTAssertTrue(DefaultBrowserRegistration.isDefault(bundleURL: bundleURL, system: system))
        XCTAssertEqual(system.probedURLs, [DefaultBrowserRegistration.probeURL])

        let other = SystemStub(handler: URL(fileURLWithPath: "/Applications/Google Chrome.app"))
        XCTAssertFalse(DefaultBrowserRegistration.isDefault(bundleURL: bundleURL, system: other))
    }

    func testMakeDefaultClaimsEverySchemeThenConfirmsTheRole() async {
        let system = SystemStub(handler: nil, handlerAfterClaim: bundleURL)

        let succeeded = await DefaultBrowserRegistration.makeDefault(bundleURL: bundleURL, system: system)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(system.claimedSchemes, ["http", "https"])
    }

    func testMakeDefaultReportsTheRoleWasNotTakenWhenTheUserDeclines() async {

        let system = SystemStub(handler: nil)

        let succeeded = await DefaultBrowserRegistration.makeDefault(bundleURL: bundleURL, system: system)

        XCTAssertFalse(succeeded)
        XCTAssertEqual(system.claimedSchemes, ["http", "https"])
    }

    func testMakeDefaultStopsAndReportsOnTheFirstFailedScheme() async {
        let failure = NSError(domain: "test", code: 7)
        let system = SystemStub(handler: nil, failure: failure)
        var reported: [Error] = []

        let succeeded = await DefaultBrowserRegistration.makeDefault(
            bundleURL: bundleURL,
            system: system,
            report: { reported.append($0) }
        )

        XCTAssertFalse(succeeded)

        XCTAssertEqual(system.claimedSchemes, ["http"])
        XCTAssertEqual(reported as? [NSError], [failure])
    }
}

private final class SystemStub: DefaultBrowserSystem {
    private let handlerAfterClaim: URL?
    private let failure: Error?
    private var handler: URL?
    private(set) var probedURLs: [URL] = []
    private(set) var claimedSchemes: [String] = []

    init(handler: URL?, handlerAfterClaim: URL? = nil, failure: Error? = nil) {
        self.handler = handler
        self.handlerAfterClaim = handlerAfterClaim
        self.failure = failure
    }

    func handlerURL(toOpen url: URL) -> URL? {
        probedURLs.append(url)
        return handler
    }

    func setDefaultApplication(at bundleURL: URL, toOpenURLsWithScheme scheme: String) async -> Error? {
        claimedSchemes.append(scheme)
        if let failure { return failure }
        if let handlerAfterClaim { handler = handlerAfterClaim }
        return nil
    }
}
