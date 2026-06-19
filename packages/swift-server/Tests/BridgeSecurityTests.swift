import HTTPTypes
import XCTest
@testable import slicc_server

/// Mirrors `packages/node-server/tests/bridge-security.test.ts`. Cross-runtime
/// parity matters here: a divergence in origin allowlist, subprotocol shape,
/// or PNA opt-in means the same webapp bridge client connects to one runtime
/// and not the other.
final class BridgeSecurityTests: XCTestCase {
    // MARK: - Origin allowlist

    func testAllowedOriginsAreAccepted() {
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("https://www.sliccy.ai"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("https://slicc-tray-hub-staging.minivelos.workers.dev"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("http://localhost:5710"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("http://127.0.0.1:5710"))
    }

    func testOriginAllowlistRejectsArbitraryOrigins() {
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("https://evil.example.com"))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("http://localhost:5711"))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("https://sliccy.ai")) // missing www.
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin(nil))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin(""))
    }

    // MARK: - Subprotocol parsing + selection

    func testParseSubprotocolHeaderSplitsOnCommaAndTrims() {
        XCTAssertEqual(BridgeSecurity.parseSubprotocolHeader(nil), [])
        XCTAssertEqual(BridgeSecurity.parseSubprotocolHeader(""), [])
        XCTAssertEqual(
            BridgeSecurity.parseSubprotocolHeader("slicc.bridge.v1.abc, other.proto"),
            ["slicc.bridge.v1.abc", "other.proto"]
        )
        XCTAssertEqual(
            BridgeSecurity.parseSubprotocolHeader("  one  ,  two  "),
            ["one", "two"]
        )
    }

    func testSelectSubprotocolMatchesPrefixAndToken() {
        let token = "deadbeef-1234"
        let expected = "slicc.bridge.v1.\(token)"
        XCTAssertEqual(
            BridgeSecurity.selectSubprotocol(["other", expected], expectedToken: token),
            expected
        )
        XCTAssertNil(
            BridgeSecurity.selectSubprotocol(["slicc.bridge.v1.wrong-token"], expectedToken: token)
        )
        XCTAssertNil(BridgeSecurity.selectSubprotocol([], expectedToken: token))
        XCTAssertNil(BridgeSecurity.selectSubprotocol([expected], expectedToken: ""))
    }

    // MARK: - validateUpgrade combined gate

    func testValidateUpgradeAcceptsMatchingOriginAndSubprotocol() {
        let token = "tok-123"
        let result = BridgeSecurity.validateUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: "slicc.bridge.v1.\(token)",
            expectedToken: token
        )
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.acceptedSubprotocol, "slicc.bridge.v1.\(token)")
        XCTAssertNil(result.reason)
    }

    func testValidateUpgradeRejectsBadOrigin() {
        let token = "tok-123"
        let result = BridgeSecurity.validateUpgrade(
            origin: "https://evil.example.com",
            subprotocolHeader: "slicc.bridge.v1.\(token)",
            expectedToken: token
        )
        XCTAssertFalse(result.ok)
        XCTAssertNil(result.acceptedSubprotocol)
        XCTAssertEqual(result.reason, .originNotAllowed)
    }

    func testValidateUpgradeRejectsMissingSubprotocol() {
        let result = BridgeSecurity.validateUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: nil,
            expectedToken: "tok-123"
        )
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.reason, .subprotocolMissingOrMismatched)
    }

    func testValidateUpgradeRejectsWrongTokenSubprotocol() {
        let result = BridgeSecurity.validateUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: "slicc.bridge.v1.wrong",
            expectedToken: "tok-123"
        )
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.reason, .subprotocolMissingOrMismatched)
    }

    // MARK: - CORS + PNA headers

    func testBuildCorsHeadersReturnsNilForDisallowedOrigin() {
        XCTAssertNil(BridgeSecurity.buildCorsHeaders(origin: "https://evil.example.com"))
        XCTAssertNil(BridgeSecurity.buildCorsHeaders(origin: nil))
    }

    func testBuildCorsHeadersEchoesOriginForAllowlistedCaller() {
        let headers = BridgeSecurity.buildCorsHeaders(origin: "https://www.sliccy.ai")
        XCTAssertNotNil(headers)
        XCTAssertEqual(headers?[HTTPField.Name("Access-Control-Allow-Origin")!], "https://www.sliccy.ai")
        XCTAssertEqual(headers?[HTTPField.Name("Access-Control-Allow-Credentials")!], "true")
        XCTAssertEqual(headers?[HTTPField.Name("Vary")!], "Origin")
        XCTAssertEqual(
            headers?[HTTPField.Name("Access-Control-Allow-Methods")!],
            "GET, POST, PUT, DELETE, OPTIONS"
        )
        let allowHeaders = headers?[HTTPField.Name("Access-Control-Allow-Headers")!] ?? ""
        XCTAssertTrue(allowHeaders.contains("X-Bridge-Token"))
        XCTAssertTrue(allowHeaders.contains("X-Session-Id"))
    }

    func testBuildPnaPreflightHeadersOptsIntoPrivateNetwork() {
        let headers = BridgeSecurity.buildPnaPreflightHeaders()
        XCTAssertEqual(
            headers[HTTPField.Name("Access-Control-Allow-Private-Network")!],
            "true"
        )
    }

    // MARK: - Token entropy

    func testMintTokenProducesUniqueValues() {
        let a = BridgeSecurity.mintToken()
        let b = BridgeSecurity.mintToken()
        XCTAssertFalse(a.isEmpty)
        XCTAssertNotEqual(a, b)
    }
}
