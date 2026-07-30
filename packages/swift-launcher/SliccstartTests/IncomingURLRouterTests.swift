import XCTest

@testable import Sliccstart

/// Routing of links macOS hands to Sliccstart while it holds the default
/// web browser role.
@MainActor
final class IncomingURLRouterTests: XCTestCase {

    func testOpenableURLsKeepsWebAndFileLinksOnly() {
        let urls = IncomingURLRouter.openableURLs(from: [
            URL(string: "https://example.com")!,
            URL(string: "http://example.org")!,
            URL(string: "file:///Users/x/page.html")!,
            URL(string: "javascript:alert(1)")!,
            URL(string: "data:text/html,<b>x</b>")!,
            URL(string: "slack://channel?id=1")!,
        ])

        XCTAssertEqual(
            urls.map(\.absoluteString),
            ["https://example.com", "http://example.org", "file:///Users/x/page.html"]
        )
    }

    func testNewTabRequestPutsTheWholeUrlInTheQueryString() {
        // Chrome reads the entire query as the target URL; a `?url=` spelling
        // silently opens about:blank, and GET is rejected since Chrome 111.
        let request = IncomingURLRouter.newTabRequest(
            cdpPort: 9222,
            target: URL(string: "https://example.com/path?a=1&b=2#frag")!
        )

        XCTAssertEqual(request?.httpMethod, "PUT")
        XCTAssertEqual(
            request?.url?.absoluteString,
            "http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1%26b%3D2%23frag"
        )
    }

    func testActivateRequestTargetsTheCreatedTab() {
        let request = IncomingURLRouter.activateRequest(cdpPort: 9333, targetId: "AB/CD 12")

        XCTAssertEqual(request?.url?.absoluteString, "http://127.0.0.1:9333/json/activate/AB%2FCD%2012")
        XCTAssertNil(IncomingURLRouter.activateRequest(cdpPort: 9333, targetId: ""))
    }

    func testCreatedTargetIdReadsTheNewTabResponse() {
        let body = Data(#"{"id":"EE4AC065","type":"page","url":"https://example.com/"}"#.utf8)
        XCTAssertEqual(IncomingURLRouter.createdTargetId(from: body), "EE4AC065")
        XCTAssertNil(IncomingURLRouter.createdTargetId(from: Data("nope".utf8)))
        XCTAssertNil(IncomingURLRouter.createdTargetId(from: Data(#"{"id":""}"#.utf8)))
    }

    func testDeliversToARunningLeaderWithoutLaunchingABrowser() async {
        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(process.launchedTargets, [])
        XCTAssertEqual(
            transport.requests.map { $0.url?.absoluteString ?? "" },
            [
                "http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fa",
                "http://127.0.0.1:9222/json/activate/tab-1",
            ]
        )
        XCTAssertEqual(transport.activatedApps, ["/Applications/Google Chrome.app"])
    }

    func testActivatesTheBrowserThatOwnsTheLeaderPortNotTheTopBrowser() async {
        // The user can start any browser by hand, so the leader is not
        // necessarily the head of the Browsers list. Talking to one browser
        // while bringing another forward would leave the link hidden.
        let leader = LeaderBrowserEndpoint(cdpPort: 9333, appPath: "/Applications/Brave Browser.app")
        let process = LeaderStub(leader: leader)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(
            transport.requests.first?.url?.absoluteString,
            "http://127.0.0.1:9333/json/new?https%3A%2F%2Fexample.com%2Fa"
        )
        XCTAssertEqual(transport.activatedApps, ["/Applications/Brave Browser.app"])
    }

    func testLaunchesTheTopBrowserAndWaitsForItsCdpPort() async {
        // The cold "click a link while no leader runs" path: the browser has
        // to be started first, and the link delivered once CDP answers.
        let process = LeaderStub(leader: nil, endpointAfterPolls: 3, endpointWhenReady: Self.chromeLeader)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(process.launchedTargets, ["Google Chrome"])
        XCTAssertEqual(
            transport.requests.first?.url?.absoluteString,
            "http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fa"
        )
    }

    func testDropsLinksWhenNoLeaderEverBecomesAvailable() async {
        let process = LeaderStub(leader: nil)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(transport.requests, [])
        // Retried rather than attempted once: a launch can lose the race
        // against startup's own auto-launch.
        XCTAssertGreaterThan(process.launchedTargets.count, 1)
    }

    func testIgnoresLinksWithNoOpenableScheme() async {
        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "slack://channel?id=1")!])

        XCTAssertEqual(transport.requests, [])
        XCTAssertEqual(process.launchedTargets, [])
    }

    func testOpensEveryQueuedLinkInOneDrain() async {
        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([
            URL(string: "https://example.com/a")!,
            URL(string: "https://example.com/b")!,
        ])

        let created = transport.requests.filter { $0.url?.path == "/json/new" }
        XCTAssertEqual(created.count, 2)
    }

    private static let chromeLeader = LeaderBrowserEndpoint(
        cdpPort: 9222,
        appPath: "/Applications/Google Chrome.app"
    )

    private func makeRouter(process: LeaderStub, transport: TransportSpy) -> IncomingURLRouter {
        let chrome = browserTarget()
        return IncomingURLRouter(
            process: process,
            topBrowser: { chrome },
            send: { request in try await transport.send(request) },
            sleep: { _ in await process.tick() },
            activateBrowser: { appPath in transport.recordActivation(appPath) }
        )
    }

    private func browserTarget() -> AppTarget {
        let path = "/Applications/Google Chrome.app"
        return AppTarget(
            id: path,
            name: "Google Chrome",
            path: path,
            executablePath: "\(path)/Contents/MacOS/Google Chrome",
            type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: "com.google.Chrome"
        )
    }
}

/// Stands in for `SliccProcess`: reports a leader endpoint, optionally only
/// after a number of wait ticks, and records launch attempts.
@MainActor
private final class LeaderStub: LeaderBrowserLaunching {
    private var endpoint: LeaderBrowserEndpoint?
    private let endpointAfterPolls: Int?
    private let endpointWhenReady: LeaderBrowserEndpoint?
    private var ticks = 0
    private(set) var launchedTargets: [String] = []

    init(
        leader: LeaderBrowserEndpoint?,
        endpointAfterPolls: Int? = nil,
        endpointWhenReady: LeaderBrowserEndpoint? = nil
    ) {
        self.endpoint = leader
        self.endpointAfterPolls = endpointAfterPolls
        self.endpointWhenReady = endpointWhenReady
    }

    var leaderBrowserEndpoint: LeaderBrowserEndpoint? { endpoint }

    func launchStandalone(_ target: AppTarget) throws {
        launchedTargets.append(target.name)
    }

    func tick() {
        ticks += 1
        if let endpointAfterPolls, ticks >= endpointAfterPolls {
            endpoint = endpointWhenReady
        }
    }
}

@MainActor
private final class TransportSpy {
    private(set) var requests: [URLRequest] = []
    private(set) var activatedApps: [String] = []

    func send(_ request: URLRequest) async throws -> (Int, Data) {
        requests.append(request)
        return (200, Data(#"{"id":"tab-1"}"#.utf8))
    }

    func recordActivation(_ appPath: String) {
        activatedApps.append(appPath)
    }
}
