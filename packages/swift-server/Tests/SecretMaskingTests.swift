import XCTest
@testable import slicc_server

final class SecretMaskingTests: XCTestCase {

    // MARK: - mask()

    func testDeterministicOutput() {
        let a = mask(sessionId: "session-1", secretName: "GITHUB_TOKEN", realValue: "ghp_abc123xyz")
        let b = mask(sessionId: "session-1", secretName: "GITHUB_TOKEN", realValue: "ghp_abc123xyz")
        XCTAssertEqual(a, b)
    }

    func testDifferentSessions() {
        let a = mask(sessionId: "session-1", secretName: "GITHUB_TOKEN", realValue: "ghp_abc123xyz")
        let b = mask(sessionId: "session-2", secretName: "GITHUB_TOKEN", realValue: "ghp_abc123xyz")
        XCTAssertNotEqual(a, b)
    }

    func testDifferentSecretNames() {
        let a = mask(sessionId: "s1", secretName: "TOKEN_A", realValue: "sk-abc123")
        let b = mask(sessionId: "s1", secretName: "TOKEN_B", realValue: "sk-abc123")
        XCTAssertNotEqual(a, b)
    }

    func testPreservesGhpPrefix() {
        let result = mask(sessionId: "s1", secretName: "GH", realValue: "ghp_abc123xyz")
        XCTAssertTrue(result.hasPrefix("ghp_"))
        XCTAssertEqual(result.count, "ghp_abc123xyz".count)
    }

    func testPreservesSkPrefix() {
        let result = mask(sessionId: "s1", secretName: "OPENAI", realValue: "sk-someLongKey123")
        XCTAssertTrue(result.hasPrefix("sk-"))
        XCTAssertEqual(result.count, "sk-someLongKey123".count)
    }

    func testPreservesAkiaPrefix() {
        let result = mask(sessionId: "s1", secretName: "AWS", realValue: "AKIAIOSFODNN7EXAMPLE")
        XCTAssertTrue(result.hasPrefix("AKIA"))
        XCTAssertEqual(result.count, "AKIAIOSFODNN7EXAMPLE".count)
    }

    func testPreservesXoxbPrefix() {
        let result = mask(sessionId: "s1", secretName: "SLACK", realValue: "xoxb-123-456-abc")
        XCTAssertTrue(result.hasPrefix("xoxb-"))
        XCTAssertEqual(result.count, "xoxb-123-456-abc".count)
    }

    func testPreservesGithubPatPrefix() {
        let result = mask(sessionId: "s1", secretName: "GH", realValue: "github_pat_abc123")
        XCTAssertTrue(result.hasPrefix("github_pat_"))
        XCTAssertEqual(result.count, "github_pat_abc123".count)
    }

    func testPreservesSkAntPrefix() {
        let result = mask(sessionId: "s1", secretName: "ANTH", realValue: "sk-ant-abcdef")
        XCTAssertTrue(result.hasPrefix("sk-ant-"))
        XCTAssertEqual(result.count, "sk-ant-abcdef".count)
    }

    func testUnknownPrefixSameLengthHex() {
        let result = mask(sessionId: "s1", secretName: "CUSTOM", realValue: "myCustomSecret123")
        XCTAssertEqual(result.count, "myCustomSecret123".count)
    }

    func testMaskedDiffersFromReal() {
        let real = "ghp_abc123xyz"
        let result = mask(sessionId: "s1", secretName: "GH", realValue: real)
        XCTAssertNotEqual(result, real)
    }

    func testVeryLongValues() {
        let real = "sk-" + String(repeating: "a", count: 200)
        let result = mask(sessionId: "s1", secretName: "KEY", realValue: real)
        XCTAssertTrue(result.hasPrefix("sk-"))
        XCTAssertEqual(result.count, real.count)
    }

    // MARK: - buildScrubber()

    func testScrubberReplacesRealValues() {
        let scrub = buildScrubber(secrets: [SecretPair(realValue: "secret123", maskedValue: "masked00")])
        XCTAssertEqual(scrub("token is secret123 here"), "token is masked00 here")
    }

    func testScrubberMultipleOccurrences() {
        let scrub = buildScrubber(secrets: [SecretPair(realValue: "abcdefghi", maskedValue: "xyz123456")])
        XCTAssertEqual(scrub("abcdefghi and abcdefghi"), "xyz123456 and xyz123456")
    }

    func testScrubberMultipleSecrets() {
        let scrub = buildScrubber(secrets: [
            SecretPair(realValue: "secret001", maskedValue: "mask_0001"),
            SecretPair(realValue: "secret002", maskedValue: "mask_0002"),
        ])
        XCTAssertEqual(scrub("secret001 and secret002"), "mask_0001 and mask_0002")
    }

    func testScrubberLongestMatchFirst() {
        let scrub = buildScrubber(secrets: [
            SecretPair(realValue: "secret-aa", maskedValue: "XXXXXXXXX"),
            SecretPair(realValue: "secret-aaaa", maskedValue: "YYYYYYYYYYY"),
        ])
        XCTAssertEqual(scrub("my secret-aaaa key"), "my YYYYYYYYYYY key")
    }

    func testScrubberEmptySecrets() {
        let scrub = buildScrubber(secrets: [])
        XCTAssertEqual(scrub("hello"), "hello")
    }

    // MARK: - MIN_MASKABLE_SECRET_LENGTH guard (parity with @slicc/shared-ts)

    func testMinMaskableSecretLengthIsNine() {
        XCTAssertEqual(MIN_MASKABLE_SECRET_LENGTH, 9)
    }

    func testScrubberSkipsValueShorterThanMinimum() {
        // 8-char value must NOT be replaced
        let eight = "abcdefgh"
        let scrub = buildScrubber(secrets: [SecretPair(realValue: eight, maskedValue: "MASKED88")])
        XCTAssertEqual(scrub("hello \(eight) world"), "hello \(eight) world")
    }

    func testScrubberKeepsValueAtMinimumLength() {
        // 9-char value masks normally
        let nine = "abcdefghi"
        let scrub = buildScrubber(secrets: [SecretPair(realValue: nine, maskedValue: "MASKED999")])
        XCTAssertEqual(scrub("hello \(nine) world"), "hello MASKED999 world")
    }

    func testScrubberBoundaryMixedShortAndLong() {
        let scrub = buildScrubber(secrets: [
            SecretPair(realValue: "short78", maskedValue: "mask7777"), // 7 chars — skipped
            SecretPair(realValue: "longSecret123", maskedValue: "longMasked123"), // 13 — kept
        ])
        XCTAssertEqual(scrub("short78 and longSecret123"), "short78 and longMasked123")
    }

    // MARK: - domainMatches()

    func testExactDomainMatch() {
        XCTAssertTrue(domainMatches(pattern: "api.github.com", hostname: "api.github.com"))
    }

    func testExactDomainMismatch() {
        XCTAssertFalse(domainMatches(pattern: "api.github.com", hostname: "evil.com"))
    }

    func testWildcardMatchesSubdomain() {
        XCTAssertTrue(domainMatches(pattern: "*.github.com", hostname: "api.github.com"))
        XCTAssertTrue(domainMatches(pattern: "*.github.com", hostname: "uploads.github.com"))
    }

    func testWildcardDoesNotMatchBareDomain() {
        XCTAssertFalse(domainMatches(pattern: "*.github.com", hostname: "github.com"))
    }

    func testCaseInsensitive() {
        XCTAssertTrue(domainMatches(pattern: "*.GitHub.COM", hostname: "API.github.com"))
        XCTAssertTrue(domainMatches(pattern: "Api.GitHub.com", hostname: "api.github.com"))
    }

    func testRejectsPartialSuffixMatch() {
        XCTAssertFalse(domainMatches(pattern: "*.github.com", hostname: "notgithub.com"))
    }

    func testBareWildcardMatchesAnyDomain() {
        XCTAssertTrue(domainMatches(pattern: "*", hostname: "api.github.com"))
        XCTAssertTrue(domainMatches(pattern: "*", hostname: "example.com"))
        XCTAssertTrue(domainMatches(pattern: "*", hostname: "localhost"))
    }

    // MARK: - isAllowedDomain()

    func testAllowedDomainAnyMatch() {
        XCTAssertTrue(isAllowedDomain(patterns: ["api.github.com", "*.openai.com"], hostname: "api.openai.com"))
    }

    func testAllowedDomainNoMatch() {
        XCTAssertFalse(isAllowedDomain(patterns: ["api.github.com"], hostname: "evil.com"))
    }

    func testAllowedDomainEmpty() {
        XCTAssertFalse(isAllowedDomain(patterns: [], hostname: "anything.com"))
    }
}

