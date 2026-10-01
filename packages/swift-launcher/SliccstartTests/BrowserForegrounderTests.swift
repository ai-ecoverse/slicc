import Darwin
import XCTest

@testable import Sliccstart

final class BrowserForegrounderTests: XCTestCase {
    private final class Spy {
        var pids: [pid_t] = [100]
        var argv: [pid_t: [String]] = [:]
        var selfActive = true
        var activateResult = true
        var activations: [pid_t] = []
        var reopens: [URL] = []

        var services: BrowserForegrounder.Services {
            .init(
                instancePIDs: { _ in self.pids },
                arguments: { self.argv[$0] },
                isSelfActive: { self.selfActive },
                yieldAndActivate: { pid in
                    self.activations.append(pid)
                    return self.activateResult
                },
                reopenViaLaunchServices: { self.reopens.append($0) }
            )
        }
    }

    private let chrome = URL(fileURLWithPath: "/Applications/Google Chrome.app")
    private var leader: LeaderBrowserEndpoint { LeaderBrowserEndpoint(cdpPort: 9222, appPath: chrome.path) }

    private func foreground(_ spy: Spy) -> BrowserForegrounder.Outcome {
        BrowserForegrounder(services: spy.services).foreground(leader)
    }

    func testYieldsActivationWhileSliccstartIsFrontmost() {
        let spy = Spy()

        XCTAssertEqual(foreground(spy), .activated)
        XCTAssertEqual(spy.activations, [100])
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    /// The bug: a cooperative activation from a background app is refused, so
    /// the link's tab stayed behind whatever the user was looking at.
    func testFallsBackToLaunchServicesWhenSliccstartIsNotActive() {
        let spy = Spy()
        spy.selfActive = false

        XCTAssertEqual(foreground(spy), .reopened)
        XCTAssertTrue(spy.activations.isEmpty, "activating from a background app is refused on macOS 14")
        XCTAssertEqual(spy.reopens, [chrome])
    }

    func testFallsBackToLaunchServicesWhenActivationIsRefused() {
        let spy = Spy()
        spy.activateResult = false

        XCTAssertEqual(foreground(spy), .reopened)
        XCTAssertEqual(spy.reopens, [chrome])
    }

    /// The user's own profile is a second process of the same bundle; the
    /// leader is the one launched with its CDP port.
    func testActivatesTheInstanceLaunchedWithTheLeadersCDPPort() {
        let spy = Spy()
        spy.pids = [100, 200]
        spy.argv = [100: ["--profile-directory=Default"], 200: ["--remote-debugging-port=9222", "--no-first-run"]]

        XCTAssertEqual(foreground(spy), .activated)
        XCTAssertEqual(spy.activations, [200])
    }

    func testDoesNotGuessAmongSeveralInstancesWithoutAUniqueMatch() {
        let spy = Spy()
        spy.pids = [100, 200]
        spy.argv = [100: ["--remote-debugging-port=9333"]]

        XCTAssertEqual(foreground(spy), .ambiguous)
        XCTAssertTrue(spy.activations.isEmpty)
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    /// LaunchServices addresses the bundle, not the leader process; with the
    /// user's own profile also running it could bring the wrong window forward.
    func testNeverReopensAnAmbiguousBundleThroughLaunchServices() {
        let spy = Spy()
        spy.pids = [100, 200]
        spy.argv = [200: ["--remote-debugging-port=9222"]]
        spy.selfActive = false
        spy.activateResult = false

        XCTAssertEqual(foreground(spy), .refused)
        XCTAssertEqual(spy.activations, [200])
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    func testDoesNothingForABrowserThatIsNotRunning() {
        let spy = Spy()
        spy.pids = []

        XCTAssertEqual(foreground(spy), .notRunning)
        XCTAssertTrue(spy.activations.isEmpty)
        XCTAssertTrue(spy.reopens.isEmpty)
    }

    func testStandardizesTheBundlePath() {
        let spy = Spy()
        var seen: URL?
        var services = spy.services
        services.instancePIDs = { url in
            seen = url
            return [100]
        }

        BrowserForegrounder(services: services)
            .foreground(LeaderBrowserEndpoint(cdpPort: 9222, appPath: "/Applications/../Applications/Google Chrome.app/"))

        XCTAssertEqual(seen, chrome)
    }

    // MARK: - argv parsing

    func testParsesProcArgs2Layout() {
        var bytes: [UInt8] = []
        withUnsafeBytes(of: Int32(3)) { bytes.append(contentsOf: $0) }
        bytes += Array("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".utf8) + [0, 0, 0]
        for arg in ["Google Chrome", "--remote-debugging-port=9222", "--no-first-run"] {
            bytes += Array(arg.utf8) + [0]
        }
        bytes += Array("HOME=/Users/x".utf8) + [0]

        XCTAssertEqual(
            BrowserForegrounder.Services.parseProcArgs(bytes),
            ["Google Chrome", "--remote-debugging-port=9222", "--no-first-run"]
        )
    }

    func testRejectsTruncatedProcArgs() {
        var bytes: [UInt8] = []
        withUnsafeBytes(of: Int32(2)) { bytes.append(contentsOf: $0) }
        bytes += Array("/bin/x".utf8) + [0] + Array("only-one".utf8) + [0]

        XCTAssertNil(BrowserForegrounder.Services.parseProcArgs(bytes))
        XCTAssertNil(BrowserForegrounder.Services.parseProcArgs([1, 0]))
    }

    func testReadsTheTestProcessesOwnArguments() {
        let argv = BrowserForegrounder.Services.processArguments(of: getpid())
        XCTAssertEqual(argv?.count, CommandLine.arguments.count)
    }
}
