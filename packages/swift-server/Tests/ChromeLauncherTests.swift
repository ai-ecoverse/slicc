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