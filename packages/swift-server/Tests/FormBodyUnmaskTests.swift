import XCTest

@testable import slicc_server

/// Mirrors `packages/shared-ts/tests/form-body-unmask.test.ts`.
final class FormBodyUnmaskTests: XCTestCase {
    // Base64-shaped: `+`, `/` and `=` are all reserved in a form body, so a
    // naive substring splice would corrupt the request.
    private static let real = "ab+cd/ef=gh&ij kl%mn"
    private static let sessionId = "session-form-unmask"

    private static let secret = SecretInjector.LoadedSecret(
        name: "FORM_SECRET",
        realValue: real,
        maskedValue: mask(sessionId: sessionId, secretName: "FORM_SECRET", realValue: real),
        domains: ["api.example.com"]
    )

    private var masked: String { Self.secret.maskedValue }

    private func injector() -> SecretInjector {
        SecretInjector(secrets: [Self.secret])
    }

    func testPercentEncodesRealValueSoFieldSurvivesRoundTrip() {
        let out = unmaskFormBody(
            text: "token=\(self.masked)&grant_type=client_credentials",
            hostname: "api.example.com",
            injector: self.injector()
        )
        XCTAssertEqual(out, "token=ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn&grant_type=client_credentials")
        XCTAssertFalse(out.contains(self.masked))
        // The `&` inside the secret must not have added a field.
        XCTAssertEqual(out.components(separatedBy: "&").count, 2)
    }

    func testLeavesUntouchedFieldsByteIdentical() {
        let body = "a=1&b=hello+world&c=%2Fpath"
        XCTAssertEqual(unmaskFormBody(text: body, hostname: "api.example.com", injector: self.injector()), body)
    }

    func testEmptyInjectorIsNoOp() {
        let body = "token=\(self.masked)"
        XCTAssertEqual(
            unmaskFormBody(text: body, hostname: "api.example.com", injector: SecretInjector(secrets: [])),
            body
        )
    }

    func testOutOfScopeDomainLeavesMaskedTokenInPlace() {
        let body = "token=\(self.masked)"
        XCTAssertEqual(unmaskFormBody(text: body, hostname: "evil.example.org", injector: self.injector()), body)
    }

    func testUnmasksClientPercentEncodedMaskedToken() {
        // The masked token is URL-safe, so an encoding client leaves it as-is;
        // decoding first is what makes the surrounding field interpretable.
        let out = unmaskFormBody(
            text: "token=\(self.masked)",
            hostname: "api.example.com",
            injector: self.injector()
        )
        XCTAssertEqual(out, "token=ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn")
    }

    func testUnmasksKeylessSingleTokenBody() {
        let out = unmaskFormBody(text: self.masked, hostname: "api.example.com", injector: self.injector())
        XCTAssertEqual(out, "ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn")
    }

    func testUnmasksEveryOccurrenceAcrossFields() {
        let out = unmaskFormBody(
            text: "a=\(self.masked)&b=keep&c=\(self.masked)",
            hostname: "api.example.com",
            injector: self.injector()
        )
        let encoded = "ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn"
        XCTAssertEqual(out, "a=\(encoded)&b=keep&c=\(encoded)")
    }

    func testMalformedEscapeFallsBackToSubstringReplace() {
        // `%zz` is not a valid escape, so the field's encoding is
        // uninterpretable — better a raw replace than a dropped secret.
        let out = unmaskFormBody(
            text: "token=%zz\(self.masked)",
            hostname: "api.example.com",
            injector: self.injector()
        )
        XCTAssertTrue(out.contains(Self.real))
        XCTAssertFalse(out.contains(self.masked))
    }

    func testSkipsEmptyValuesAndEmptyBody() {
        XCTAssertEqual(unmaskFormBody(text: "", hostname: "api.example.com", injector: self.injector()), "")
        XCTAssertEqual(
            unmaskFormBody(text: "a=&b=", hostname: "api.example.com", injector: self.injector()),
            "a=&b="
        )
    }
}
