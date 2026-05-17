import Foundation
import XCTest
@testable import slicc_server

final class ChromeLauncherTests: XCTestCase {
    func testFindChromeExecutablePrefersChromePathEnvironmentVariable() {
        let chromePath = "/custom/chrome"
        let launcher = makeLauncher(
            existingPaths: [chromePath],
            environment: ["CHROME_PATH": chromePath]
        )

        XCTAssertEqual(launcher.findChromeExecutable(), chromePath)
    }

    func testFindChromeExecutablePrefersInstalledChromeBeforeChromeForTesting() {
        let installed = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        let cached = "/project/node_modules/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        let launcher = makeLauncher(
            existingPaths: [installed, cached],
            directoryListings: ["/project/node_modules/.cache/puppeteer/chrome": ["mac-123"]],
            currentDirectory: "/project"
        )

        XCTAssertEqual(launcher.findChromeExecutable(), installed)
    }

    func testFindChromeExecutableFindsChromeForTestingInProjectNodeModulesCache() {
        let cached = "/project/node_modules/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        let launcher = makeLauncher(
            existingPaths: [cached],
            directoryListings: ["/project/node_modules/.cache/puppeteer/chrome": ["mac-123"]],
            currentDirectory: "/project"
        )

        XCTAssertEqual(launcher.findChromeExecutable(), cached)
    }

    func testBuildLaunchArgsIncludesExtensionFlagsAndLaunchURLLast() {
        let launcher = makeLauncher()
        let args = launcher.buildLaunchArgs(
            cdpPort: 9333,
            launchUrl: "http://127.0.0.1:5710",
            userDataDir: "/tmp/profile",
            extensionPath: "/tmp/ext"
        )

        XCTAssertEqual(args[0], "--remote-debugging-port=9333")
        XCTAssertTrue(args.contains("--user-data-dir=/tmp/profile"))
        XCTAssertTrue(args.contains("--disable-extensions-except=/tmp/ext"))
        XCTAssertTrue(args.contains("--load-extension=/tmp/ext"))
        XCTAssertEqual(args.last, "http://127.0.0.1:5710")
    }

    func testResolveAppBundleWalksUpFromCanonicalChromeExecutable() {
        let launcher = makeLauncher()

        XCTAssertEqual(
            launcher.resolveAppBundle(
                forExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ),
            "/Applications/Google Chrome.app"
        )
    }

    func testResolveAppBundleHandlesChromeForTestingPath() {
        let launcher = makeLauncher()
        let cached = "/Users/test/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

        XCTAssertEqual(
            launcher.resolveAppBundle(forExecutable: cached),
            "/Users/test/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app"
        )
    }

    func testResolveAppBundleReturnsNilForBareBinary() {
        let launcher = makeLauncher()

        XCTAssertNil(launcher.resolveAppBundle(forExecutable: "/usr/local/bin/chromium"))
        XCTAssertNil(launcher.resolveAppBundle(forExecutable: "/tmp/just-a-binary"))
    }

    func testBuildOpenLaunchArgsRoutesThroughLaunchServicesWithChromeArgs() {
        let launcher = makeLauncher()
        let chromeArgs = launcher.buildLaunchArgs(
            cdpPort: 9333,
            launchUrl: "http://127.0.0.1:5710",
            userDataDir: "/tmp/profile",
            extensionPath: nil
        )
        let args = launcher.buildOpenLaunchArgs(
            appBundlePath: "/Applications/Google Chrome.app",
            chromeArgs: chromeArgs
        )

        // The `-n -a <bundle> -W --args …` shape is what frees Chrome from
        // slicc-server's TCC responsibility chain. Pin the prefix so a
        // refactor that drops `--args` (which would swallow the Chrome
        // flags into `open`'s own option parser) breaks the build.
        XCTAssertEqual(args[0], "-n")
        XCTAssertEqual(args[1], "-a")
        XCTAssertEqual(args[2], "/Applications/Google Chrome.app")
        XCTAssertEqual(args[3], "-W")
        XCTAssertEqual(args[4], "--args")
        XCTAssertEqual(Array(args.suffix(chromeArgs.count)), chromeArgs)
    }

    func testResolveUserDataDirAddsSuffixForNonDefaultServePort() {
        let launcher = makeLauncher(environment: ["TMPDIR": "/tmp/runtime"])

        XCTAssertEqual(
            launcher.resolveUserDataDir(servePort: 5720),
            "/tmp/runtime/browser-coding-agent-chrome-5720"
        )
        XCTAssertEqual(
            launcher.resolveUserDataDir(servePort: 5710),
            "/tmp/runtime/browser-coding-agent-chrome"
        )
    }

    func testParseCdpPortFromStderrExtractsPort() {
        XCTAssertEqual(
            ChromeLauncher.parseCdpPortFromStderr(
                "DevTools listening on ws://127.0.0.1:9333/devtools/browser/test"
            ),
            9333
        )
        XCTAssertNil(ChromeLauncher.parseCdpPortFromStderr("something else"))
    }

    func testWaitForCDPRetriesUntilWebSocketDebuggerUrlAppears() async throws {
        let response = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:9333/json/version")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        var attempts = 0
        let launcher = ChromeLauncher(
            fetchData: { _ in
                attempts += 1
                if attempts < 3 {
                    return (Data("{}".utf8), response)
                }
                return (
                    Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/browser/test"}"#.utf8),
                    response
                )
            }
        )

        let webSocketURL = try await launcher.waitForCDP(port: 9333, retries: 5, delay: 0.001)

        XCTAssertEqual(webSocketURL, "ws://127.0.0.1:9333/devtools/browser/test")
        XCTAssertEqual(attempts, 3)
    }

    func testProbeExistingChromeReturnsBrowserWhenCdpIsLive() async {
        let payload = Data(#"{"Browser":"Chrome/147.0.7727.101","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/test"}"#.utf8)
        let okResponse = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:9222/json/version")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        let launcher = ChromeLauncher(
            fetchData: { _ in (payload, okResponse) }
        )

        let browser = await launcher.probeExistingChrome(cdpPort: 9222)

        XCTAssertEqual(browser, "Chrome/147.0.7727.101")
    }

    func testProbeExistingChromeReturnsNilWhenNothingResponds() async {
        let launcher = ChromeLauncher(
            fetchData: { _ in throw URLError(.cannotConnectToHost) }
        )

        let browser = await launcher.probeExistingChrome(cdpPort: 9222)

        XCTAssertNil(browser)
    }

    func testProbeExistingChromeRejectsNonCdpHttpResponses() async {
        // Some other HTTP service (e.g. a dev server) squatting on the port
        // must not be mistaken for a Chrome CDP endpoint.
        let payload = Data(#"{"hello":"world"}"#.utf8)
        let okResponse = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:9222/json/version")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        let launcher = ChromeLauncher(
            fetchData: { _ in (payload, okResponse) }
        )

        let browser = await launcher.probeExistingChrome(cdpPort: 9222)

        XCTAssertNil(browser)
    }

    func testLaunchFailsFastWhenCdpPortIsAlreadyServingChrome() async throws {
        let chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        let cdpResponse = Data(#"{"Browser":"Chrome/147.0.7727.101","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/test"}"#.utf8)
        let okResponse = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:9222/json/version")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!

        final class SpawnCounter: @unchecked Sendable {
            var count = 0
        }
        let spawns = SpawnCounter()

        let launcher = ChromeLauncher(
            fileExists: { $0 == chromePath },
            processFactory: {
                spawns.count += 1
                return Process()
            },
            fetchData: { _ in (cdpResponse, okResponse) }
        )

        do {
            _ = try await launcher.launch(config: ChromeLaunchConfig(
                cdpPort: 9222,
                launchUrl: "http://localhost:5710",
                userDataDir: "/tmp/user-data",
                executablePath: chromePath
            ))
            XCTFail("expected chromeAlreadyRunning but launch succeeded")
        } catch ChromeLauncherError.chromeAlreadyRunning(let port, let browser) {
            XCTAssertEqual(port, 9222)
            XCTAssertEqual(browser, "Chrome/147.0.7727.101")
        } catch {
            XCTFail("expected chromeAlreadyRunning but got \(error)")
        }

        XCTAssertEqual(spawns.count, 0, "processFactory must not be invoked when a Chrome is already on the CDP port")
    }

    private func makeLauncher(
        existingPaths: Set<String> = [],
        directoryListings: [String: [String]] = [:],
        environment: [String: String] = [:],
        currentDirectory: String = "/workspace",
        homeDirectory: String = "/Users/test"
    ) -> ChromeLauncher {
        ChromeLauncher(
            fileExists: { existingPaths.contains($0) },
            directoryContents: { path in directoryListings[path] ?? [] },
            environmentProvider: { environment },
            currentDirectoryProvider: { currentDirectory },
            homeDirectoryProvider: { homeDirectory }
        )
    }
}