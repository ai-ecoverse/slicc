import XCTest

@testable import SliccFollower

/// The `Network` domain is what makes an iOS follower a real teleport
/// destination. Before it existed the whole domain answered `{}` with no
/// error, so the leader read `result.cookies ?? []` as "zero cookies" and a
/// cookie teleport reported success while delivering nothing.
final class CDPNetworkDomainTests: XCTestCase {

    private func cookie(
        name: String = "session",
        value: String = "s3cret",
        domain: String = ".example.com",
        path: String = "/",
        secure: Bool = false,
        expires: Date? = nil
    ) -> HTTPCookie {
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain, .path: path,
        ]
        if secure { props[.secure] = "TRUE" }
        if let expires { props[.expires] = expires }
        return HTTPCookie(properties: props)!
    }

    func testEncodeProducesTheCdpCookieShape() {
        let expiry = Date(timeIntervalSince1970: 1_800_000_000)
        let encoded = CDPNetworkDomain.encode(cookie(secure: true, expires: expiry))

        XCTAssertEqual(encoded["name"] as? String, "session")
        XCTAssertEqual(encoded["value"] as? String, "s3cret")
        XCTAssertEqual(encoded["domain"] as? String, ".example.com")
        XCTAssertEqual(encoded["path"] as? String, "/")
        XCTAssertEqual(encoded["secure"] as? Bool, true)
        XCTAssertEqual(encoded["expires"] as? Double, 1_800_000_000)
        XCTAssertEqual(
            encoded["session"] as? Bool, false,
            "a cookie with an expiry is not a session cookie")
    }

    func testEncodeMarksSessionCookiesWithExpiresMinusOne() {
        let encoded = CDPNetworkDomain.encode(cookie())
        XCTAssertEqual(encoded["session"] as? Bool, true)
        XCTAssertEqual(
            encoded["expires"] as? Double, -1,
            "CDP spells 'no expiry' as -1, not a missing key")
    }

    func testDecodeRoundTripsTheFieldsAuthenticationDependsOn() {
        let expiry = Date(timeIntervalSince1970: 1_800_000_000)
        let encoded = CDPNetworkDomain.encode(cookie(secure: true, expires: expiry))
        let decoded = CDPNetworkDomain.decode(encoded)

        XCTAssertEqual(decoded?.name, "session")
        XCTAssertEqual(decoded?.value, "s3cret")
        XCTAssertEqual(decoded?.domain, ".example.com")
        XCTAssertEqual(decoded?.path, "/")
        XCTAssertEqual(decoded?.isSecure, true)
        XCTAssertEqual(decoded?.expiresDate?.timeIntervalSince1970, 1_800_000_000)
    }

    func testDecodeRejectsPayloadsHTTPCookieCannotRepresent() {
        XCTAssertNil(
            CDPNetworkDomain.decode(["value": "v", "domain": "example.com"]),
            "no name")
        XCTAssertNil(
            CDPNetworkDomain.decode(["name": "n", "domain": "example.com"]),
            "no value")
        XCTAssertNil(
            CDPNetworkDomain.decode(["name": "n", "value": "v"]),
            "no domain — HTTPCookie requires one, and a wrong guess would leak the cookie")
    }

    func testDecodeDefaultsPathAndTreatsAbsentSecureAsInsecure() {
        let decoded = CDPNetworkDomain.decode([
            "name": "n", "value": "v", "domain": "example.com",
        ])
        XCTAssertEqual(decoded?.path, "/")
        XCTAssertEqual(decoded?.isSecure, false)
    }

    func testFilterScopesCookiesToTheRequestedUrlsIncludingParentDomains() {
        let cookies = [
            cookie(name: "a", domain: ".example.com"),
            cookie(name: "b", domain: "app.example.com"),
            cookie(name: "c", domain: "other.test"),
        ]
        let scoped = CDPNetworkDomain.filter(cookies, urls: ["https://app.example.com/dash"])
        XCTAssertEqual(
            scoped.map(\.name).sorted(), ["a", "b"],
            "a host matches both its own cookies and its parent domain's")
    }

    func testFilterWithNoUrlsReturnsEverything() {
        let cookies = [cookie(name: "a"), cookie(name: "b", domain: "other.test")]
        XCTAssertEqual(CDPNetworkDomain.filter(cookies, urls: []).count, 2)
    }

    func testOnlyTheCookieSurfaceClaimsSupport() {
        // Everything supported is really implemented; everything else must
        // return a not-implemented ERROR rather than an empty success.
        for method in [
            "Network.enable", "Network.disable", "Network.getCookies",
            "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies",
        ] {
            XCTAssertTrue(CDPNetworkDomain.isSupported(method), method)
        }
        for method in [
            "Network.setRequestInterception", "Network.getResponseBody",
            "Network.emulateNetworkConditions", "Network.setExtraHTTPHeaders",
        ] {
            XCTAssertFalse(
                CDPNetworkDomain.isSupported(method),
                "\(method) has no WKWebView equivalent and must fail loudly")
        }
    }
}
