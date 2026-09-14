import Logging
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

    

    func testMatchesConsolePageURLReturnsFalseForEmptyExpected() {
        XCTAssertFalse(matchesConsolePageURL("http://localhost:5710/", expectedPageURL: ""))
        XCTAssertFalse(matchesConsolePageURL("http://localhost:5710/", expectedPageURL: "   "))
    }

    func testMatchesConsolePageURLMatchesLoopbackHostPort() {
        XCTAssertTrue(matchesConsolePageURL("http://localhost:5710/foo", expectedPageURL: "5710"))
        XCTAssertTrue(matchesConsolePageURL("http://127.0.0.1:5710/foo", expectedPageURL: "5710"))
    }

    func testMatchesConsolePageURLRejectsNonLoopbackForPortLookup() {
        XCTAssertFalse(matchesConsolePageURL("http://example.com:5710/", expectedPageURL: "5710"))
    }

    func testMatchesConsolePageURLRejectsWrongPort() {
        XCTAssertFalse(matchesConsolePageURL("http://localhost:5710/", expectedPageURL: "9999"))
    }

    func testMatchesConsolePageURLEqualsAndContainsFallbacks() {
        XCTAssertTrue(matchesConsolePageURL("https://example.com/abc", expectedPageURL: "https://example.com/abc"))
        XCTAssertTrue(matchesConsolePageURL("https://example.com/path/abc", expectedPageURL: "/abc"))
        XCTAssertFalse(matchesConsolePageURL("https://example.com/", expectedPageURL: "no-match"))
    }

    

    func testSelectConsolePageTargetReturnsNilWhenNoMatch() {
        let targets = [
            ConsolePageTarget(type: "page", url: "http://localhost:5710/", webSocketDebuggerURL: "ws://x")
        ]
        XCTAssertNil(selectConsolePageTarget(from: targets, matching: "9999"))
    }

    func testSelectConsolePageTargetSkipsTargetsWithoutDebuggerURL() {
        let targets = [
            ConsolePageTarget(type: "page", url: "http://localhost:5710/", webSocketDebuggerURL: nil),
            ConsolePageTarget(type: "page", url: "http://localhost:5710/foo", webSocketDebuggerURL: "ws://ok"),
        ]
        let match = selectConsolePageTarget(from: targets, matching: "5710")
        XCTAssertEqual(match?.webSocketDebuggerURL, "ws://ok")
    }

    

    func testConsoleTaggedLineForEmptyArgs() {
        XCTAssertEqual(consoleTaggedLine(args: []), "[page]")
    }

    func testConsoleTaggedLineJoinsArgsWithSpaces() {
        let args = [
            ConsoleRemoteObject(type: "string", value: .string("hi"), description: nil),
            ConsoleRemoteObject(type: "number", value: .number(42), description: nil),
        ]
        XCTAssertEqual(consoleTaggedLine(args: args), "[page] hi 42")
    }

    

    func testSerializeConsoleArgumentFallsBackWhenDescriptionIsEmpty() {
        XCTAssertEqual(
            serializeConsoleArgument(.init(type: "function", value: nil, description: "")),
            "function"
        )
    }

    

    func testConsoleForwarderErrorDescriptions() {
        let discovery = ConsoleForwarderError.discoveryFailed("nope")
        let invalid = ConsoleForwarderError.invalidWebSocketURL("ws://bad")
        XCTAssertEqual(discovery.errorDescription, "nope")
        XCTAssertEqual(invalid.errorDescription, "ws://bad")
    }

    

    func testConsolePageTargetDecodesWebSocketDebuggerUrlKey() throws {
        let json = """
            {"type":"page","url":"http:
            """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ConsolePageTarget.self, from: json)
        XCTAssertEqual(decoded.type, "page")
        XCTAssertEqual(decoded.webSocketDebuggerURL, "ws:
    }

    

    func testConsoleEventDecodesArgsArray() throws {
        let json = """
            {"type":"log","args":[{"type":"string","value":"hi"},{"type":"object","description":"{ a: 1 }"}]}
            """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ConsoleEvent.self, from: json)
        XCTAssertEqual(decoded.type, "log")
        XCTAssertEqual(decoded.args.count, 2)
        XCTAssertEqual(decoded.args[0].value, .string("hi"))
        XCTAssertEqual(decoded.args[1].description, "{ a: 1 }")
    }

    

    func testConsoleJSONValueDecodesStringNumberBoolNull() throws {
        XCTAssertEqual(try decodeJSONValue("\"hi\""), .string("hi"))
        XCTAssertEqual(try decodeJSONValue("12"), .number(12))
        XCTAssertEqual(try decodeJSONValue("true"), .bool(true))
        XCTAssertEqual(try decodeJSONValue("null"), .null)
    }

    func testConsoleJSONValueDecodesArrayAndObject() throws {
        let array = try decodeJSONValue("[1,\"two\",false]")
        XCTAssertEqual(array, .array([.number(1), .string("two"), .bool(false)]))

        let object = try decodeJSONValue("{\"k\":\"v\",\"n\":7}")
        XCTAssertEqual(object, .object(["k": .string("v"), "n": .number(7)]))
    }

    func testConsoleJSONValueStringValueForPrimitives() {
        XCTAssertEqual(ConsoleJSONValue.string("hi").stringValue, "hi")
        XCTAssertEqual(ConsoleJSONValue.number(7).stringValue, "7")
        XCTAssertEqual(ConsoleJSONValue.number(7.5).stringValue, "7.5")
        XCTAssertEqual(ConsoleJSONValue.bool(true).stringValue, "true")
        XCTAssertEqual(ConsoleJSONValue.null.stringValue, "null")
    }

    func testConsoleJSONValueStringValueSerializesObjectAndArray() {
        let object = ConsoleJSONValue.object(["k": .string("v")])
        let array = ConsoleJSONValue.array([.number(1), .number(2)])
        XCTAssertEqual(object.stringValue, "{\"k\":\"v\"}")
        XCTAssertEqual(array.stringValue, "[1,2]")
    }

    private func decodeJSONValue(_ literal: String) throws -> ConsoleJSONValue {
        
        
        
        let wrapped = "[\(literal)]".data(using: .utf8)!
        let arr = try JSONDecoder().decode([ConsoleJSONValue].self, from: wrapped)
        return arr[0]
    }

    

    func testConsoleForwarderStartStopIsIdempotent() async {
        let forwarder = ConsoleForwarder(
            session: .shared,
            logger: Logger(label: "test-forwarder"),
            output: { _ in }
        )
        
        
        await forwarder.start(cdpPort: 1, pageUrl: "5710")
        await forwarder.stop()
        await forwarder.stop()
    }

    

    func testConsoleEventEnvelopeDecodesPartialEnvelope() throws {
        let json = """
            {"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[]}}
            """.data(using: .utf8)!
        let envelope = try JSONDecoder().decode(ConsoleEventEnvelope.self, from: json)
        XCTAssertEqual(envelope.method, "Runtime.consoleAPICalled")
        XCTAssertEqual(envelope.params?.type, "log")
        XCTAssertEqual(envelope.params?.args.isEmpty, true)
    }

    

    func testSerializeConsoleArgumentFractionalNumberPreservesDecimals() {
        let arg = ConsoleRemoteObject(type: "number", value: .number(3.25), description: nil)
        XCTAssertEqual(serializeConsoleArgument(arg), "3.25")
    }

    

    func testRenderedConsoleLineForUnknownTypeIsPlain() {
        let args = [ConsoleRemoteObject(type: "string", value: .string("hi"), description: nil)]
        XCTAssertEqual(renderedConsoleLine(type: "info", args: args), "[page] hi")
        XCTAssertEqual(renderedConsoleLine(type: "debug", args: args), "[page] hi")
    }
}
