import XCTest

@testable import Sliccstart

@MainActor
final class AgentActivityProbeTests: XCTestCase {
    func testNoRunningServersReturnsFalseWithoutFetching() async {
        let probe = AgentActivityProbe(fetch: { _ in
            XCTFail("fetch must not run without a running server")
            return (200, Data())
        })

        let process = SliccProcess(agentActivityProbe: probe)
        process._testing_seedLaunchRecord(
            id: "stopped-server",
            process: Process(),
            targetType: .chromiumBrowser,
            cdpPort: 39_220,
            servePort: 35_710,
            targetName: "Stopped Server"
        )

        let isActive = await process.hasRecentAgentActivity()
        XCTAssertFalse(isActive)
    }

    func testReturnsTrueWhenAnyRunningServerReportsActive() async throws {
        let requests = RequestedPorts()
        let process = SliccProcess(
            agentActivityProbe: AgentActivityProbe(fetch: { url in
                await requests.record(url.port)
                let isActive = url.port == 35_711 && url.path == "/api/agent-activity"
                return (200, Data(#"{"activeInLastMinute":\#(isActive)}"#.utf8))
            }))
        let helpers = try seedRunningServers(on: process, servePorts: [35_710, 35_711])
        addTeardownBlock { helpers.forEach { if $0.isRunning { $0.terminate() } } }

        let isActive = await process.hasRecentAgentActivity()
        XCTAssertTrue(isActive)
        let requestedPorts = await requests.values
        XCTAssertEqual(requestedPorts, [35_710, 35_711])
    }

    func testReturnsFalseWhenRunningServersAreInactiveOrUnreachable() async throws {
        let process = SliccProcess(
            agentActivityProbe: AgentActivityProbe(fetch: { url in
                if url.port == 35_712 {
                    throw URLError(.cannotConnectToHost)
                }
                return (200, Data(#"{"activeInLastMinute":false}"#.utf8))
            }))
        let helpers = try seedRunningServers(on: process, servePorts: [35_710, 35_712])
        addTeardownBlock { helpers.forEach { if $0.isRunning { $0.terminate() } } }

        let isActive = await process.hasRecentAgentActivity()
        XCTAssertFalse(isActive)
    }

    private func seedRunningServers(on process: SliccProcess, servePorts: [UInt16]) throws -> [Process] {
        try servePorts.enumerated().map { index, servePort in
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: "/bin/sleep")
            helper.arguments = ["60"]
            try helper.run()
            process._testing_seedLaunchRecord(
                id: "server-\(index)",
                process: helper,
                targetType: .chromiumBrowser,
                cdpPort: UInt16(39_220 + index),
                servePort: servePort,
                targetName: "Server \(index)"
            )
            return helper
        }
    }
}

private actor RequestedPorts {
    private(set) var values: Set<Int> = []

    func record(_ port: Int?) {
        if let port { values.insert(port) }
    }
}
