import XCTest

@testable import Sliccstart

/// Handler-identity comparison and the claim flow for the default-browser
/// role. LaunchServices is behind `DefaultBrowserSystem` here: the real calls
/// raise the macOS confirmation panel and rewrite the user's system-wide
/// handler.
final class DefaultBrowserRegistrationTests: XCTestCase {
    private let bundleURL = URL(fileURLWithPath: "/Applications/Sliccstart.app", isDirectory: true)

    func testClaimsBothWebSchemes() {
        // LaunchServices only accepts a handler change for a scheme the
        // bundle advertises, so these must stay in step with the
        // CFBundleURLTypes block in assemble-app.mjs.
        XCTAssertEqual(DefaultBrowserRegistration.handledSchemes, ["http", "https"])
    }

    func testMatchesIgnoresTrailingSlashDifferences() {
        // LaunchServices answers with a canonical directory URL, which may
        // carry a trailing slash the bundle URL does not.
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
        // macOS returns **no error** when the user dismisses its confirmation
        // panel, so the claim's return value is not evidence — the role has to
        // be re-read.
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
        // Bailed out after http rather than pestering the user again for https.
        XCTAssertEqual(system.claimedSchemes, ["http"])
        XCTAssertEqual(reported as? [NSError], [failure])
    }
}

/// Stands in for LaunchServices: reports a handler, records the claims, and
/// can flip to "we hold the role" once a claim goes through.
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
