import XCTest

@testable import slicc_server

final class TabSessionStoreTests: XCTestCase {
    private let sliccOrigins = ["https://www.sliccy.ai", "http://localhost:5710"]

    func testSanitizeKeepsHttpAndHttpsPagesInFirstSeenOrder() {
        let urls = TabSessionStore.sanitize(
            rawUrls: ["https://example.com/a", "http://example.org/b", "https://example.com/a"],
            hostedOrigins: sliccOrigins
        )

        XCTAssertEqual(urls, ["https://example.com/a", "http://example.org/b"])
    }

    func testSanitizeDropsNonWebSchemesAndFlagShapedEntries() {
        // Every surviving entry becomes a Chrome argv slot, so anything that
        // could be read as a switch — or as a local file / script URL — must
        // not make it through.
        let urls = TabSessionStore.sanitize(
            rawUrls: [
                "--headless=new",
                "--user-data-dir=/tmp/evil",
                "file:///etc/passwd",
                "javascript:alert(1)",
                "chrome://settings",
                "chrome-extension://abc/page.html",
                "devtools://devtools/bundled/inspector.html",
                "about:blank",
                "",
                "https://example.com/keep",
            ],
            hostedOrigins: sliccOrigins
        )

        XCTAssertEqual(urls, ["https://example.com/keep"])
    }

    func testSanitizeDropsSliccOriginsAndBridgeCarryingTabs() {
        let urls = TabSessionStore.sanitize(
            rawUrls: [
                "https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp&bridgeToken=abc",
                "https://www.sliccy.ai/pricing",
                "http://localhost:5710/api/status",
                "https://staging.example/?bridgeToken=abc",
                "https://example.com/keep",
            ],
            hostedOrigins: sliccOrigins
        )

        XCTAssertEqual(urls, ["https://example.com/keep"])
    }

    func testSanitizeCapsRestoredTabs() {
        let many = (0..<(TabSessionStore.maxRestoredTabs + 10)).map { "https://example.com/\($0)" }

        let urls = TabSessionStore.sanitize(rawUrls: many, hostedOrigins: [])

        XCTAssertEqual(urls.count, TabSessionStore.maxRestoredTabs)
        XCTAssertEqual(urls.first, "https://example.com/0")
    }

    func testDefaultFileURLIsKeyedByProfileDirectoryName() {
        let url = TabSessionStore.defaultFileURL(
            userDataDir: "/Users/x/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome-5720",
            homeDirectory: "/Users/x"
        )

        XCTAssertEqual(
            url.path,
            "/Users/x/Library/Application Support/Slicc/sessions/browser-coding-agent-chrome-5720-tabs.json"
        )
    }

    func testSaveThenLoadRoundTripsSanitizedUrls() throws {
        let store = TabSessionStore(fileURL: makeTemporaryFileURL())

        store.save(
            urls: ["https://example.com/a", "chrome://settings", "https://www.sliccy.ai/pricing"],
            hostedOrigins: sliccOrigins
        )

        XCTAssertEqual(store.load(hostedOrigins: sliccOrigins), ["https://example.com/a"])
    }

    func testLoadReappliesSanitizationToAnEditedFile() throws {
        let fileURL = makeTemporaryFileURL()
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let payload = #"{"updatedAt":0,"urls":["--headless","https://example.com/a"]}"#
        try Data(payload.utf8).write(to: fileURL)

        XCTAssertEqual(
            TabSessionStore(fileURL: fileURL).load(hostedOrigins: sliccOrigins),
            ["https://example.com/a"]
        )
    }

    func testLoadReturnsEmptyForMissingOrCorruptSnapshot() throws {
        let missing = makeTemporaryFileURL()
        XCTAssertEqual(TabSessionStore(fileURL: missing).load(hostedOrigins: []), [])

        try FileManager.default.createDirectory(
            at: missing.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("not json".utf8).write(to: missing)
        XCTAssertEqual(TabSessionStore(fileURL: missing).load(hostedOrigins: []), [])
    }

    func testNormalizedOriginIncludesExplicitPortAndLowercasesHost() {
        XCTAssertEqual(TabSessionStore.normalizedOrigin(of: "HTTP://LocalHost:8787/x"), "http://localhost:8787")
        XCTAssertEqual(TabSessionStore.normalizedOrigin(of: "https://www.sliccy.ai/"), "https://www.sliccy.ai")
        XCTAssertNil(TabSessionStore.normalizedOrigin(of: "chrome://settings"))
    }

    private func makeTemporaryFileURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("slicc-tab-session-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("tabs.json")
    }
}
