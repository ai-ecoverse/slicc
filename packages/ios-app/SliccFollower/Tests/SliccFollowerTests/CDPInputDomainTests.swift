import XCTest

@testable import SliccFollower

/// Synthetic key events must carry the fields Chrome uses for form submit.
/// A `KeyboardEvent` with only `key: 'Enter'` leaves `keyCode === 0` in
/// WKWebView and never implicit-submits (#3772, sibling of #3768).
final class CDPInputDomainTests: XCTestCase {

    private let enterKeyDown: [String: Any] = [
        "type": "keyDown",
        "key": "Enter",
        "code": "Enter",
        "windowsVirtualKeyCode": 13,
        "text": "\r",
        "unmodifiedText": "\r",
    ]

    func testEnterKeyDownDefinesKeyCodeWhichAndCode() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript(enterKeyDown)
        XCTAssertTrue(js.contains("keyCode"), js)
        XCTAssertTrue(js.contains("which"), js)
        XCTAssertTrue(js.contains("Object.defineProperty"), "WK ignores keyCode on KeyboardEventInit")
        XCTAssertTrue(js.contains("\"Enter\""), js)
        XCTAssertTrue(js.contains("keyCode = 13") || js.contains("keyCode =13"), js)
    }

    func testEnterKeyDownKeepsLeaderTextAndDispatchesKeypress() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript(enterKeyDown)
        XCTAssertTrue(js.contains("\\r") || js.contains("\\u000d"), "text '\\r' must survive as a JS string, not a raw CR")
        XCTAssertTrue(js.contains("keypress"), js)
        XCTAssertTrue(
            js.contains("requestSubmit(defaultBtn)"),
            "implicit submit must pass the default button so its click/formaction run; bare requestSubmit() is not enough")
        XCTAssertTrue(js.contains("count <= 1"), "buttonless forms submit only with at most one blocking field")
    }

    func testRawKeyDownEnterDoesNotSynthesizeKeypressOrSubmit() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript([
            "type": "rawKeyDown",
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
            "text": "\r",
        ])
        XCTAssertTrue(js.contains("keydown"), js)
        XCTAssertFalse(js.contains("keypress"), js)
        XCTAssertFalse(js.contains("requestSubmit"), js)
        XCTAssertTrue(js.contains("keyCode = 13") || js.contains("keyCode =13"), js)
    }

    func testNativeVirtualKeyCodeIsNotUsedAsDomKeyCode() {
        XCTAssertEqual(
            CDPInputDomain.keyCode(from: ["nativeVirtualKeyCode": 36, "key": "Enter"]),
            13,
            "macOS Return native 36 must not replace the key-name mapping to 13")
        XCTAssertEqual(
            CDPInputDomain.keyCode(from: ["nativeVirtualKeyCode": 36]),
            0,
            "native-only payloads must not leak platform scan codes as DOM keyCode")
        XCTAssertEqual(
            CDPInputDomain.keyCode(from: [
                "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 36, "key": "Enter",
            ]),
            13)
    }

    func testEnterKeyUpDoesNotSubmit() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript([
            "type": "keyUp",
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
        ])
        XCTAssertTrue(js.contains("keyup"), js)
        XCTAssertFalse(js.contains("requestSubmit"), js)
        XCTAssertTrue(js.contains("keyCode = 13") || js.contains("keyCode =13"), js)
    }

    func testWindowsVirtualKeyCodeIsNotDiscardedWhenKeyIsBare() {
        XCTAssertEqual(
            CDPInputDomain.keyCode(from: ["windowsVirtualKeyCode": 13, "key": "Enter"]),
            13)
        XCTAssertEqual(
            CDPInputDomain.keyCode(from: ["windowsVirtualKeyCode": 27.0, "key": "Escape"]),
            27,
            "JSON numbers may arrive as Double through AnyCodable")
    }

    func testEnterWithoutVkStillMapsTo13() {
        XCTAssertEqual(CDPInputDomain.keyCode(from: ["key": "Enter"]), 13)
        let js = CDPInputDomain.dispatchKeyEventJavaScript([
            "type": "keyDown", "key": "Enter", "text": "\r",
        ])
        XCTAssertTrue(js.contains("keyCode = 13") || js.contains("keyCode =13"), js)
        XCTAssertTrue(js.contains("keypress"), js)
    }

    func testPrintableKeyDownKeepsTextLiteral() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript([
            "type": "keyDown",
            "key": "a",
            "code": "KeyA",
            "windowsVirtualKeyCode": 65,
            "text": "a",
        ])
        XCTAssertTrue(js.contains("\"a\""), js)
        XCTAssertTrue(js.contains("\"KeyA\""), js)
        XCTAssertTrue(js.contains("keyCode = 65") || js.contains("keyCode =65"), js)
        XCTAssertTrue(js.contains("keypress"), js)
        XCTAssertFalse(js.contains("requestSubmit"), js)
    }

    func testCharTypeStillInsertsText() {
        let js = CDPInputDomain.dispatchKeyEventJavaScript([
            "type": "char", "text": "hello\"world",
        ])
        XCTAssertTrue(js.contains("el.value += text"), js)
        XCTAssertTrue(js.contains("hello"), js)
        XCTAssertTrue(js.contains("\\\""), "double quotes must be JSON-escaped, not raw")
        XCTAssertFalse(js.contains("KeyboardEvent"), js)
    }

    func testJsLiteralEncodesCarriageReturn() {
        XCTAssertEqual(CDPInputDomain.jsLiteral("\r"), "\"\\r\"")
    }
}
