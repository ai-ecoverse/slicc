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

    // MARK: - Dev-origin env parity (BRIDGE_DEV_ALLOWED_ORIGINS)

    func testNormalizeDevOriginTrimsLowercasesAndStripsTrailingSlash() {
        XCTAssertEqual(BridgeSecurity.normalizeDevOrigin("  HTTP://Localhost:8787/  "), "http://localhost:8787")
        XCTAssertEqual(BridgeSecurity.normalizeDevOrigin("http://localhost:8787///"), "http://localhost:8787")
        XCTAssertEqual(BridgeSecurity.normalizeDevOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
    }

    func testNormalizeDevOriginRejectsBlankOrMalformed() {
        XCTAssertNil(BridgeSecurity.normalizeDevOrigin(""))
        XCTAssertNil(BridgeSecurity.normalizeDevOrigin("   "))
        XCTAssertNil(BridgeSecurity.normalizeDevOrigin("/"))
        XCTAssertNil(BridgeSecurity.normalizeDevOrigin("not a url"))
    }

    func testParseDevAllowedOriginsSplitsNormalizesAndDropsBlanks() {
        XCTAssertEqual(BridgeSecurity.parseDevAllowedOrigins(nil), [])
        XCTAssertEqual(BridgeSecurity.parseDevAllowedOrigins(""), [])
        XCTAssertEqual(
            BridgeSecurity.parseDevAllowedOrigins("http://localhost:8787, ,HTTP://127.0.0.1:8787/"),
            ["http://localhost:8787", "http://127.0.0.1:8787"]
        )
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
        XCTAssertEqual(headers?[HTTPField.Name("Vary")!], "Origin, Access-Control-Request-Headers")
        // Must mirror the node-server CORS_ALLOW_METHODS byte-for-byte and
        // cover the full /api/fetch-proxy verb set (PATCH + WebDAV/CalDAV) so
        // Chrome's preflight doesn't reject those proxied methods.
        XCTAssertEqual(
            headers?[HTTPField.Name("Access-Control-Allow-Methods")!],
            "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT, COPY, MOVE, LOCK, UNLOCK"
        )
        let allowHeaders = headers?[HTTPField.Name("Access-Control-Allow-Headers")!] ?? ""
        XCTAssertTrue(allowHeaders.contains("X-Bridge-Token"))
        XCTAssertTrue(allowHeaders.contains("X-Session-Id"))
    }

    func testBuildCorsHeadersAllowsFetchProxyTransportHeaders() {
        // `createProxiedFetch` always sends X-Target-URL plus the encoded
        // forbidden-header X-Proxy-* bridges; the preflight MUST allow them or
        // the browser blocks the POST after a passing preflight ("Failed to
        // fetch"). Mirrors node-server's CORS_BASE_ALLOW_HEADERS.
        let headers = BridgeSecurity.buildCorsHeaders(origin: "https://www.sliccy.ai")
        let allowHeaders = headers?[HTTPField.Name("Access-Control-Allow-Headers")!] ?? ""
        XCTAssertTrue(allowHeaders.contains("X-Target-URL"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Cookie"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Origin"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Referer"))
    }

    func testBuildCorsHeadersExposesProxyResponseMarkers() {
        // Clients read X-Proxy-Error (isProxyError) and X-Proxy-Set-Cookie
        // (decodeForbiddenResponseHeaders) from the response, so both must be
        // listed in Access-Control-Expose-Headers.
        let headers = BridgeSecurity.buildCorsHeaders(origin: "https://www.sliccy.ai")
        XCTAssertEqual(
            headers?[HTTPField.Name("Access-Control-Expose-Headers")!],
            "Link, X-Proxy-Error, X-Proxy-Set-Cookie"
        )
    }

    func testResolveCorsAllowHeadersReflectsExtraRequestedHeaders() {
        // Reflect-headers pattern: an agent's `curl -H X-Custom: …` routed
        // through /api/fetch-proxy must have X-Custom allowed without us
        // enumerating it in advance. Already-listed headers are not duplicated
        // (case-insensitive).
        let resolved = BridgeSecurity.resolveCorsAllowHeaders("X-Custom-One, content-type, X-Custom-Two")
        XCTAssertTrue(resolved.contains("X-Custom-One"))
        XCTAssertTrue(resolved.contains("X-Custom-Two"))
        XCTAssertTrue(resolved.contains("Content-Type"))
        XCTAssertFalse(resolved.lowercased().contains("content-type, content-type"))
    }

    func testResolveCorsAllowHeadersFallsBackToBaseWhenAbsent() {
        let base = BridgeSecurity.corsBaseAllowHeaders.joined(separator: ", ")
        XCTAssertEqual(BridgeSecurity.resolveCorsAllowHeaders(nil), base)
        XCTAssertEqual(BridgeSecurity.resolveCorsAllowHeaders(""), base)
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

    // MARK: - Loopback origin (token-gate exemption)

    func testIsLoopbackBridgeOriginAcceptsLoopbackHosts() {
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://localhost:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://127.0.0.1:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://[::1]:5710"))
    }

    func testIsLoopbackBridgeOriginRejectsRemoteAndMalformed() {
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin("https://www.sliccy.ai"))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin(nil))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin(""))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin("not a url"))
    }

    // MARK: - Bridge token validation

    func testValidateBridgeTokenAcceptsMatchingToken() {
        XCTAssertTrue(BridgeSecurity.validateBridgeToken("abc123", "abc123"))
    }

    func testValidateBridgeTokenRejectsMismatchAndEdgeCases() {
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", "abc124")) // same length, different
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc", "abc123")) // length mismatch
        XCTAssertFalse(BridgeSecurity.validateBridgeToken(nil, "abc123")) // missing presented
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("", "abc123")) // empty presented
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", nil)) // missing expected
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", "")) // empty expected
    }
}
