import XCTest
@testable import slicc_server

final class SecretInjectorTests: XCTestCase {

    private func makeInjector(secrets: [SecretInjector.LoadedSecret]) -> SecretInjector {
        SecretInjector(secrets: secrets)
    }

    private func makeSecret(
        name: String = "GITHUB_TOKEN",
        realValue: String = "ghp_realSecret123",
        maskedValue: String = "ghp_masked999abc",
        domains: [String] = ["api.github.com", "*.github.com"]
    ) -> SecretInjector.LoadedSecret {
        .init(name: name, realValue: realValue, maskedValue: maskedValue, domains: domains)
    }

    // MARK: - inject()

    func testInjectReplacesMatchedMaskWithRealValue() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.inject(text: "Bearer ghp_masked999abc", hostname: "api.github.com")
        guard case .success(let text) = result else { return XCTFail("Expected success") }
        XCTAssertEqual(text, "Bearer ghp_realSecret123")
    }

    func testInjectLeavesTextUnchangedWhenNoMaskPresent() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.inject(text: "Bearer some-other-token", hostname: "api.github.com")
        guard case .success(let text) = result else { return XCTFail("Expected success") }
        XCTAssertEqual(text, "Bearer some-other-token")
    }

    func testInjectReturnsDomainBlockedForUnauthorizedDomain() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.inject(text: "Bearer ghp_masked999abc", hostname: "evil.com")
        guard case .domainBlocked(let secretName, let hostname) = result else {
            return XCTFail("Expected domainBlocked")
        }
        XCTAssertEqual(secretName, "GITHUB_TOKEN")
        XCTAssertEqual(hostname, "evil.com")
    }

    func testInjectAllowsWildcardDomain() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.inject(text: "ghp_masked999abc", hostname: "uploads.github.com")
        guard case .success(let text) = result else { return XCTFail("Expected success") }
        XCTAssertEqual(text, "ghp_realSecret123")
    }

    func testInjectMultipleSecretsInSameText() {
        let injector = makeInjector(secrets: [
            makeSecret(name: "GH", realValue: "ghp_real1", maskedValue: "ghp_mask1", domains: ["api.github.com"]),
            makeSecret(name: "AI", realValue: "sk-real2", maskedValue: "sk-mask2", domains: ["api.github.com", "api.openai.com"]),
        ])
        let result = injector.inject(text: "GH=ghp_mask1 AI=sk-mask2", hostname: "api.github.com")
        guard case .success(let text) = result else { return XCTFail("Expected success") }
        XCTAssertEqual(text, "GH=ghp_real1 AI=sk-real2")
    }

    func testInjectBlocksIfAnySecretDomainFails() {
        let injector = makeInjector(secrets: [
            makeSecret(name: "GH", realValue: "ghp_real1", maskedValue: "ghp_mask1", domains: ["api.github.com"]),
            makeSecret(name: "AI", realValue: "sk-real2", maskedValue: "sk-mask2", domains: ["api.openai.com"]),
        ])
        // Text contains both masked values, but hostname only matches GH
        let result = injector.inject(text: "ghp_mask1 sk-mask2", hostname: "api.github.com")
        guard case .domainBlocked(let secretName, _) = result else {
            return XCTFail("Expected domainBlocked")
        }
        XCTAssertEqual(secretName, "AI")
    }

    // MARK: - injectBody()

    func testInjectBodyLeavesMaskedValueWhenDomainDoesNotMatch() {
        let injector = makeInjector(secrets: [makeSecret()])
        // Body contains masked value but domain doesn't match — should leave as-is
        let result = injector.injectBody(text: "conversation: ghp_masked999abc was used", hostname: "bedrock-runtime.us-west-2.amazonaws.com")
        XCTAssertTrue(result.contains("ghp_masked999abc"))
        XCTAssertFalse(result.contains("ghp_realSecret123"))
    }

    func testInjectBodyUnmasksWhenDomainMatches() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.injectBody(text: "token=ghp_masked999abc", hostname: "api.github.com")
        XCTAssertFalse(result.contains("ghp_masked999abc"))
        XCTAssertTrue(result.contains("ghp_realSecret123"))
    }

    func testInjectBodyPartiallyUnmasksWhenSomeDomainsMatch() {
        let injector = makeInjector(secrets: [
            makeSecret(name: "GH", realValue: "ghp_real1", maskedValue: "ghp_mask1", domains: ["api.github.com"]),
            makeSecret(name: "AI", realValue: "sk-real2", maskedValue: "sk-mask2", domains: ["api.openai.com"]),
        ])
        // Send to api.github.com — GH should unmask, AI should stay masked
        let result = injector.injectBody(text: "ghp_mask1 sk-mask2", hostname: "api.github.com")
        XCTAssertTrue(result.contains("ghp_real1"))
        XCTAssertTrue(result.contains("sk-mask2"))
        XCTAssertFalse(result.contains("sk-real2"))
    }

    // MARK: - scrub()

    func testScrubReplacesRealValuesWithMasked() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.scrub(text: "token: ghp_realSecret123")
        XCTAssertEqual(result, "token: ghp_masked999abc")
    }

    func testScrubMultipleOccurrences() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.scrub(text: "ghp_realSecret123 and ghp_realSecret123")
        XCTAssertEqual(result, "ghp_masked999abc and ghp_masked999abc")
    }

    func testScrubMultipleSecrets() {
        let injector = makeInjector(secrets: [
            makeSecret(name: "A", realValue: "secret_a", maskedValue: "masked_a", domains: ["a.com"]),
            makeSecret(name: "B", realValue: "secret_b", maskedValue: "masked_b", domains: ["b.com"]),
        ])
        let result = injector.scrub(text: "A=secret_a B=secret_b")
        XCTAssertEqual(result, "A=masked_a B=masked_b")
    }

    func testScrubLeavesTextUnchangedWhenNoRealValues() {
        let injector = makeInjector(secrets: [makeSecret()])
        let result = injector.scrub(text: "nothing to scrub here")
        XCTAssertEqual(result, "nothing to scrub here")
    }

    // MARK: - isEmpty

    func testIsEmptyWithNoSecrets() {
        let injector = makeInjector(secrets: [])
        XCTAssertTrue(injector.isEmpty)
    }

    func testIsEmptyWithSecrets() {
        let injector = makeInjector(secrets: [makeSecret()])
        XCTAssertFalse(injector.isEmpty)
    }

    // MARK: - maskedEnvironment

    func testMaskedEnvironmentReturnsMaskedValues() {
        let injector = makeInjector(secrets: [
            makeSecret(name: "TOKEN_A", realValue: "real_a", maskedValue: "mask_a", domains: ["a.com"]),
            makeSecret(name: "TOKEN_B", realValue: "real_b", maskedValue: "mask_b", domains: ["b.com"]),
        ])
        let env = injector.maskedEnvironment
        XCTAssertEqual(env["TOKEN_A"], "mask_a")
        XCTAssertEqual(env["TOKEN_B"], "mask_b")
        XCTAssertEqual(env.count, 2)
    }

    // MARK: - Integration with mask() function

    func testInitWithSessionIdProducesDeterministicMasks() {
        // Use real masking to verify integration — can't use Keychain in tests
        // so just verify the mask function is called correctly
        let realValue = "ghp_testValue123"
        let sessionId = "test-session-42"
        let maskedA = mask(sessionId: sessionId, secretName: "GH", realValue: realValue)
        let maskedB = mask(sessionId: sessionId, secretName: "GH", realValue: realValue)
        XCTAssertEqual(maskedA, maskedB)
        XCTAssertNotEqual(maskedA, realValue)
        XCTAssertTrue(maskedA.hasPrefix("ghp_"))
    }
}

