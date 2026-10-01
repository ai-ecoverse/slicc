import XCTest

@testable import Sliccstart

final class BrowserForegrounderTests: XCTestCase {
    private final class Spy {
        var instances = 1
        var selfActive = true
        var activateResult = true
        var activations: [URL] = []
        var reopens: [URL] = []

        var services: BrowserForegrounder.Services {
            .init(
                instanceCount: { _ in self.instances },
                isSelfActive: { self.selfActive },
                yieldAndActivate: { url in
                    self.activations.append(url)
                    return self.activateResult
                },
                reopenViaLaunchServices: { self.reopens.append($0) }
            )
        }
    }

    private let chrome = URL(fileURLWithPath: "/Applications/Google Chrome.app")

    func testYieldsActivationWhileSliccstartIsFrontmost() {
        let spy = Spy()

        let outcome = BrowserForegrounder(services: spy.services).foreground(appPath: chrome.path)

        XCTAssertEqual(outcome, .activated)
        XCTAssertEqual(spy.activations, [chrome])
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    /// The bug: a cooperative activation from a background app is refused, so
    /// the link's tab stayed behind whatever the user was looking at.
    func testFallsBackToLaunchServicesWhenSliccstartIsNotActive() {
        let spy = Spy()
        spy.selfActive = false

        let outcome = BrowserForegrounder(services: spy.services).foreground(appPath: chrome.path)

        XCTAssertEqual(outcome, .reopened)
        XCTAssertTrue(spy.activations.isEmpty, "activating from a background app is refused on macOS 14")
        XCTAssertEqual(spy.reopens, [chrome])
    }

    func testFallsBackToLaunchServicesWhenActivationIsRefused() {
        let spy = Spy()
        spy.activateResult = false

        let outcome = BrowserForegrounder(services: spy.services).foreground(appPath: chrome.path)

        XCTAssertEqual(outcome, .reopened)
        XCTAssertEqual(spy.reopens, [chrome])
    }

    /// LaunchServices addresses the bundle, not the leader process; with the
    /// user's own profile also running it could bring the wrong window forward.
    func testNeverReopensAnAmbiguousBundleThroughLaunchServices() {
        let spy = Spy()
        spy.instances = 2
        spy.selfActive = false
        spy.activateResult = false

        let outcome = BrowserForegrounder(services: spy.services).foreground(appPath: chrome.path)

        XCTAssertEqual(outcome, .refused)
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    func testDoesNothingForABrowserThatIsNotRunning() {
        let spy = Spy()
        spy.instances = 0

        let outcome = BrowserForegrounder(services: spy.services).foreground(appPath: chrome.path)

        XCTAssertEqual(outcome, .notRunning)
        XCTAssertTrue(spy.activations.isEmpty)
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    func testStandardizesTheBundlePath() {
        let spy = Spy()
        var seen: URL?
        var services = spy.services
        services.instanceCount = { url in
            seen = url
            return 1
        }

        BrowserForegrounder(services: services).foreground(appPath: "/Applications/../Applications/Google Chrome.app/")

        XCTAssertEqual(seen, chrome)
    }
}
