import XCTest

@testable import Sliccstart

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

        XCTAssertGreaterThan(process.launchedTargets.count, 1)
    }

    func testSkipsAFollowerBrowserWhenPickingOneToStart() async {

        let browsers = [browserTarget(name: "Google Chrome"), browserTarget(name: "Brave Browser")]
        let process = LeaderStub(leader: nil, followerNames: ["Google Chrome"])
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport, browsers: browsers)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertFalse(process.launchedTargets.contains("Google Chrome"))
        XCTAssertEqual(Set(process.launchedTargets), ["Brave Browser"])
    }

    func testReportsWhenTheCreatedTabCannotBeActivated() async {

        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy(activateStatus: 500)
        let reported = ErrorSpy()
        let router = makeRouter(process: process, transport: transport, report: reported.record)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(
            reported.errors as? [IncomingURLRouterError],
            [.activateRejected(status: 500)]
        )
    }

    func testReportsWhenTheNewTabResponseHasNoTargetId() async {
        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy(newTabBody: Data("{}".utf8))
        let reported = ErrorSpy()
        let router = makeRouter(process: process, transport: transport, report: reported.record)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(
            reported.errors as? [IncomingURLRouterError],
            [.newTabResponseUnreadable]
        )
    }

    func testReportsWhenTheBrowserRejectsTheNewTab() async {
        let process = LeaderStub(leader: Self.chromeLeader)
        let transport = TransportSpy(newTabStatus: 500)
        let reported = ErrorSpy()
        let router = makeRouter(process: process, transport: transport, report: reported.record)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(reported.errors as? [IncomingURLRouterError], [.newTabRejected(status: 500)])
    }

    func testReportsWhenNoBrowserIsInstalledAtAll() async {
        let process = LeaderStub(leader: nil)
        let reported = ErrorSpy()
        let router = makeRouter(
            process: process,
            transport: TransportSpy(),
            browsers: [],
            report: reported.record
        )

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(process.launchedTargets, [])
        XCTAssertEqual(reported.errors as? [IncomingURLRouterError], [.leaderUnavailable])
    }

    func testKeepsWaitingWhenALaunchAttemptThrows() async {

        let process = LeaderStub(
            leader: nil,
            endpointAfterPolls: 3,
            endpointWhenReady: Self.chromeLeader,
            launchError: LaunchStubError.portInUse
        )
        let transport = TransportSpy()
        let router = makeRouter(process: process, transport: transport)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(
            transport.requests.first?.url?.absoluteString,
            "http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fa"
        )
    }

    func testEveryFailureCarriesAUserReadableDescription() {
        let descriptions: [String] = [
            IncomingURLRouterError.leaderUnavailable,
            .newTabRejected(status: 500),
            .newTabResponseUnreadable,
            .activateRejected(status: 404),
        ].map { $0.localizedDescription }

        XCTAssertEqual(descriptions.count, Set(descriptions).count)
        XCTAssertFalse(descriptions.contains { $0.isEmpty })
    }

    func testProductionDefaultsResolveTheInstalledBrowsers() {

        let router = IncomingURLRouter(process: LeaderStub(leader: nil))
        XCTAssertNotNil(router)
        for browser in IncomingURLRouter.defaultOrderedBrowsers() {
            XCTAssertEqual(browser.type, .chromiumBrowser)
        }
    }

    func testDroppedLinksAreReported() async {
        let process = LeaderStub(leader: nil)
        let reported = ErrorSpy()
        let router = makeRouter(process: process, transport: TransportSpy(), report: reported.record)

        await router.handle([URL(string: "https://example.com/a")!])

        XCTAssertEqual(reported.errors as? [IncomingURLRouterError], [.leaderUnavailable])
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

    private func makeRouter(
        process: LeaderStub,
        transport: TransportSpy,
        browsers: [AppTarget]? = nil,
        report: @escaping (Error) -> Void = { _ in }
    ) -> IncomingURLRouter {
        let ordered = browsers ?? [browserTarget(name: "Google Chrome")]
        return IncomingURLRouter(
            process: process,
            orderedBrowsers: { ordered },
            send: { request in try await transport.send(request) },
            sleep: { _ in await process.tick() },
            activateBrowser: { appPath in transport.recordActivation(appPath) },
            report: report
        )
    }

    private func browserTarget(name: String) -> AppTarget {
        let path = "/Applications/\(name).app"
        return AppTarget(
            id: path,
            name: name,
            path: path,
            executablePath: "\(path)/Contents/MacOS/\(name)",
            type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: "com.example.\(name)"
        )
    }
}

@MainActor
private final class LeaderStub: LeaderBrowserLaunching {
    private var endpoint: LeaderBrowserEndpoint?
    private let endpointAfterPolls: Int?
    private let endpointWhenReady: LeaderBrowserEndpoint?
    private var ticks = 0
    private(set) var launchedTargets: [String] = []

    private let followerNames: Set<String>
    private let launchError: Error?

    init(
        leader: LeaderBrowserEndpoint?,
        endpointAfterPolls: Int? = nil,
        endpointWhenReady: LeaderBrowserEndpoint? = nil,
        followerNames: Set<String> = [],
        launchError: Error? = nil
    ) {
        self.endpoint = leader
        self.endpointAfterPolls = endpointAfterPolls
        self.endpointWhenReady = endpointWhenReady
        self.followerNames = followerNames
        self.launchError = launchError
    }

    var leaderBrowserEndpoint: LeaderBrowserEndpoint? { endpoint }

    func isRunningAsFollower(_ target: AppTarget) -> Bool {
        followerNames.contains(target.name)
    }

    func launchStandalone(_ target: AppTarget) throws {
        launchedTargets.append(target.name)
        if let launchError { throw launchError }
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
    private let activateStatus: Int
    private let newTabStatus: Int
    private let newTabBody: Data

    init(
        activateStatus: Int = 200,
        newTabStatus: Int = 200,
        newTabBody: Data = Data(#"{"id":"tab-1"}"#.utf8)
    ) {
        self.activateStatus = activateStatus
        self.newTabStatus = newTabStatus
        self.newTabBody = newTabBody
    }

    func send(_ request: URLRequest) async throws -> (Int, Data) {
        requests.append(request)
        if request.url?.path.hasPrefix("/json/activate") == true {
            return (activateStatus, Data())
        }
        return (newTabStatus, newTabBody)
    }

    func recordActivation(_ appPath: String) {
        activatedApps.append(appPath)
    }
}

private enum LaunchStubError: Error {
    case portInUse
}

@MainActor
private final class ErrorSpy {
    private(set) var errors: [Error] = []

    func record(_ error: Error) {
        errors.append(error)
    }
}
