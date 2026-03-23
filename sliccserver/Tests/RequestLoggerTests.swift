import Hummingbird
import XCTest
@testable import slicc_server

final class RequestLoggerTests: XCTestCase {
    func testColorPrefixMatchesStatusFamily() {
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 200), RequestLogger<BasicRequestContext>.green)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 302), RequestLogger<BasicRequestContext>.yellow)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 404), RequestLogger<BasicRequestContext>.red)
        XCTAssertEqual(RequestLogger<BasicRequestContext>.colorPrefix(for: 101), RequestLogger<BasicRequestContext>.reset)
    }

    func testColoredStatusCodeWrapsResetCode() {
        XCTAssertEqual(
            RequestLogger<BasicRequestContext>.coloredStatusCode(204),
            "\u{1b}[32m204\u{1b}[0m"
        )
    }
}