import HTTPTypes
import XCTest

@testable import slicc_server





final class BridgeSecurityTests: XCTestCase {
    

    func testAllowedOriginsAreAccepted() {
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("https://www.sliccy.ai"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("https://slicc-tray-hub-staging.minivelos.workers.dev"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("http://localhost:5710"))
        XCTAssertTrue(BridgeSecurity.isAllowedOrigin("http://127.0.0.1:5710"))
    }

    func testOriginAllowlistRejectsArbitraryOrigins() {
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("https://evil.example.com"))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("http://localhost:5711"))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin("https://sliccy.ai"))  
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin(nil))
        XCTAssertFalse(BridgeSecurity.isAllowedOrigin(""))
    }

    

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

    func testUpgradeRejectionLogDetailSplitsMissingFromMismatched() {
        XCTAssertEqual(
            BridgeSecurity.upgradeRejectionLogDetail(
                reason: BridgeSecurity.RejectionReason.subprotocolMissingOrMismatched.rawValue,
                subprotocolHeader: nil
            ),
            "subprotocol-missing"
        )
        XCTAssertEqual(
            BridgeSecurity.upgradeRejectionLogDetail(
                reason: BridgeSecurity.RejectionReason.subprotocolMissingOrMismatched.rawValue,
                subprotocolHeader: "  "
            ),
            "subprotocol-missing"
        )
        XCTAssertEqual(
            BridgeSecurity.upgradeRejectionLogDetail(
                reason: BridgeSecurity.RejectionReason.subprotocolMissingOrMismatched.rawValue,
                subprotocolHeader: "slicc.bridge.v1.stale"
            ),
            "subprotocol-mismatched"
        )
        XCTAssertEqual(
            BridgeSecurity.upgradeRejectionLogDetail(
                reason: BridgeSecurity.RejectionReason.originNotAllowed.rawValue,
                subprotocolHeader: "slicc.bridge.v1.stale"
            ),
            "origin-not-allowed"
        )
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
        
        
        
        XCTAssertEqual(
            headers?[HTTPField.Name("Access-Control-Allow-Methods")!],
            "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT, COPY, MOVE, LOCK, UNLOCK"
        )
        let allowHeaders = headers?[HTTPField.Name("Access-Control-Allow-Headers")!] ?? ""
        XCTAssertTrue(allowHeaders.contains("X-Bridge-Token"))
        XCTAssertTrue(allowHeaders.contains("X-Session-Id"))
    }

    func testBuildCorsHeadersAllowsFetchProxyTransportHeaders() {
        
        
        
        
        let headers = BridgeSecurity.buildCorsHeaders(origin: "https://www.sliccy.ai")
        let allowHeaders = headers?[HTTPField.Name("Access-Control-Allow-Headers")!] ?? ""
        XCTAssertTrue(allowHeaders.contains("X-Target-URL"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Cookie"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Origin"))
        XCTAssertTrue(allowHeaders.contains("X-Proxy-Referer"))
    }

    func testBuildCorsHeadersExposesProxyResponseMarkers() {
        
        
        let headers = BridgeSecurity.buildCorsHeaders(origin: "https://www.sliccy.ai")
        XCTAssertEqual(
            headers?[HTTPField.Name("Access-Control-Expose-Headers")!],
            "Link, X-Proxy-Error, X-Proxy-Set-Cookie, X-Proxy-Www-Authenticate, Mcp-Session-Id, MCP-Protocol-Version"
        )
    }

    func testResolveCorsAllowHeadersReflectsExtraRequestedHeaders() {
        
        
        
        
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

    

    func testMintTokenProducesUniqueValues() {
        let a = BridgeSecurity.mintToken()
        let b = BridgeSecurity.mintToken()
        XCTAssertFalse(a.isEmpty)
        XCTAssertNotEqual(a, b)
    }

    

    func testIsLoopbackHostnameAcceptsCanonicalSet() {
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("localhost"))
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("127.0.0.1"))
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("127.0.0.2"))
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("127.255.255.255"))
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("::1"))
        XCTAssertTrue(BridgeSecurity.isLoopbackHostname("[::1]"))
    }

    func testIsLoopbackHostnameRejectsLookalikes() {
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname(""))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("www.sliccy.ai"))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("localhost.evil.com"))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("192.168.0.1"))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("10.0.0.5"))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("::2"))
        XCTAssertFalse(BridgeSecurity.isLoopbackHostname("0.0.0.0"))
    }

    func testIsLoopbackBridgeOriginAcceptsLoopbackHosts() {
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://localhost:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://127.0.0.1:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://127.0.0.2:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://[::1]:5710"))
        XCTAssertTrue(BridgeSecurity.isLoopbackBridgeOrigin("http://localhost"))
    }

    func testIsLoopbackBridgeOriginRejectsRemoteAndMalformed() {
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin("https://www.sliccy.ai"))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin("https://localhost.evil.com"))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin(nil))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin(""))
        XCTAssertFalse(BridgeSecurity.isLoopbackBridgeOrigin("not a url"))
    }

    

    func testValidateBridgeTokenAcceptsMatchingToken() {
        XCTAssertTrue(BridgeSecurity.validateBridgeToken("abc123", "abc123"))
    }

    func testValidateBridgeTokenRejectsMismatchAndEdgeCases() {
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", "abc124"))  
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc", "abc123"))  
        XCTAssertFalse(BridgeSecurity.validateBridgeToken(nil, "abc123"))  
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("", "abc123"))  
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", nil))  
        XCTAssertFalse(BridgeSecurity.validateBridgeToken("abc123", ""))  
    }
}
