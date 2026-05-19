import AppKit
import XCTest
@testable import Sliccstart

final class AppRuntimeStateTests: XCTestCase {
    func testElectronAppDefaultsToNotRunning() {
        XCTAssertEqual(
            AppRuntimeState.resolve(targetType: .electronApp),
            .notRunning
        )
    }

    func testElectronAppRunningWithoutKnownDebugPortOffersRestartState() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                appIsRunning: true
            ),
            .runningWithoutDebug
        )
    }

    func testKnownDebugPortWinsOverExternalRunningState() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                debugPort: 9227,
                appIsRunning: true
            ),
            .runningWithDebug(cdpPort: 9227)
        )
    }

    func testStartFailureIsShownWhenAppIsNotRunning() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                launchFailure: "SLICC exited with code 1."
            ),
            .startFailed(message: "SLICC exited with code 1.")
        )
    }

    func testRunningAppSupersedesPreviousStartFailure() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                launchFailure: "SLICC exited with code 1.",
                appIsRunning: true
            ),
            .runningWithoutDebug
        )
    }

    func testCannotStartWhenPermissionIsMissing() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                hasAppManagementPermission: false,
                appIsRunning: true
            ),
            .cannotStart(.needsPermission)
        )
    }

    func testCannotStartWhenDebugBuildIsRequired() {
        XCTAssertEqual(
            AppRuntimeState.resolve(
                targetType: .electronApp,
                debugSupport: .disabled,
                appIsRunning: true
            ),
            .cannotStart(.needsDebugBuild)
        )
    }

    func testDebugBuildLaunchRecordOnlyTerminatesDebugCopy() {
        let target = makeElectronTarget(
            path: "/Users/test/Applications/Slack Debug.app",
            originalAppPath: "/Applications/Slack.app"
        )

        XCTAssertEqual(
            SliccProcess.launchedAppPaths(for: target),
            ["/Users/test/Applications/Slack Debug.app"]
        )
        XCTAssertEqual(
            SliccProcess.relatedAppPaths(for: target),
            ["/Users/test/Applications/Slack Debug.app", "/Applications/Slack.app"]
        )
    }

    private func makeElectronTarget(path: String, originalAppPath: String?) -> AppTarget {
        AppTarget(
            id: path,
            name: "Slack",
            path: path,
            executablePath: "\(path)/Contents/MacOS/Slack",
            type: .electronApp,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported,
            isDebugBuild: originalAppPath != nil,
            originalAppPath: originalAppPath
        )
    }
}
