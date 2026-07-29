import XCTest

@testable import Sliccstart

/// Handler-identity comparison for the default-browser role. The mutating
/// half (`makeDefault`) is not exercised here: it raises the macOS
/// confirmation panel and rewrites the user's real LaunchServices database.
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
}
