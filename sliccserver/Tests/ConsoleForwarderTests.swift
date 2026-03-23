import XCTest
@testable import slicc_server

final class ConsoleForwarderTests: XCTestCase {
    func testSelectConsolePageTargetMatchesLocalhostPort() {
        let targets = [
            ConsolePageTarget(type: "other", url: "devtools://devtools/bundled/inspector.html", webSocketDebuggerURL: "ws://ignored"),
            ConsolePageTarget(type: "page", url: "http://localhost:5710/?prompt=test", webSocketDebuggerURL: "ws://page-target"),
        ]

        let match = selectConsolePageTarget(from: targets, matching: "5710")

        XCTAssertEqual(match?.webSocketDebuggerURL, "ws://page-target")
    }

    func testSerializeConsoleArgumentPrefersValueThenDescriptionThenType() {
        XCTAssertEqual(
            serializeConsoleArgument(.init(type: "string", value: .string("hello"), description: "ignored")),
            "hello"
        )
        XCTAssertEqual(
            serializeConsoleArgument(.init(type: "object", value: nil, description: "{ ready: true }")),
            "{ ready: true }"
        )
        XCTAssertEqual(
            serializeConsoleArgument(.init(type: "undefined", value: nil, description: nil)),
            "undefined"
        )
    }

    func testRenderedConsoleLineAppliesWarningAndErrorColors() {
        let args = [ConsoleRemoteObject(type: "string", value: .string("careful"), description: nil)]

        XCTAssertEqual(renderedConsoleLine(type: "log", args: args), "[page] careful")
        XCTAssertEqual(renderedConsoleLine(type: "warning", args: args), "\u{1b}[33m[page] careful\u{1b}[0m")
        XCTAssertEqual(renderedConsoleLine(type: "error", args: args), "\u{1b}[31m[page] careful\u{1b}[0m")
    }
}