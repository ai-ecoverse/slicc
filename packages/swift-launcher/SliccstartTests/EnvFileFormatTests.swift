import XCTest
@testable import Sliccstart

final class EnvFileFormatTests: XCTestCase {

    func testRoundTripPreservesNamesValuesAndDomains() {
        let original = [
            Secret(name: "GITHUB_TOKEN", value: "ghp_abc", domains: ["api.github.com", "*.github.com"]),
            Secret(name: "OPENAI_KEY", value: "sk-xyz", domains: ["api.openai.com"]),
        ]
        let blob = EnvFileFormat.serialize(original)
        let parsed = EnvFileFormat.parseSecrets(blob)
        XCTAssertEqual(parsed, original)
    }

    func testRoundTripPreservesValuesWithQuotesAndHash() {
        let original = [
            Secret(name: "TOKEN", value: #"value with "quotes" and #hash"#, domains: ["a.com"]),
        ]
        let blob = EnvFileFormat.serialize(original)
        let parsed = EnvFileFormat.parseSecrets(blob)
        XCTAssertEqual(parsed, original)
    }

    func testParseSkipsKeysWithoutDomains() {
        let blob = """
        ORPHAN=value-no-domains
        VALID=v
        VALID_DOMAINS=a.com
        """
        let secrets = EnvFileFormat.parseSecrets(blob)
        XCTAssertEqual(secrets.count, 1)
        XCTAssertEqual(secrets.first?.name, "VALID")
    }

    func testParseAcceptsReversedOrder() {
        let blob = """
        TOKEN_DOMAINS=api.example.com
        TOKEN=hello
        """
        let parsed = EnvFileFormat.parseSecrets(blob)
        XCTAssertEqual(parsed, [Secret(name: "TOKEN", value: "hello", domains: ["api.example.com"])])
    }

    func testParseSkipsBlankAndCommentLines() {
        let blob = """

        # comment
        FOO=bar
        FOO_DOMAINS=a.com

        # another comment
        """
        let parsed = EnvFileFormat.parseSecrets(blob)
        XCTAssertEqual(parsed, [Secret(name: "FOO", value: "bar", domains: ["a.com"])])
    }

    func testParseDomainsTrimsAndDropsEmpties() {
        XCTAssertEqual(EnvFileFormat.parseDomains(" a.com , , *.b.com "), ["a.com", "*.b.com"])
        XCTAssertTrue(EnvFileFormat.parseDomains("").isEmpty)
        XCTAssertTrue(EnvFileFormat.parseDomains(" , , ").isEmpty)
    }

    // MARK: - hostname pattern validation

    func testIsValidHostnamePatternAcceptsAllowedShapes() {
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("example.com"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("api.github.com"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*.example.com"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*.api.github.com"))
        // Single-label hosts are valid (e.g. localhost, internal services).
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("localhost"))
        // Underscores and dashes inside labels are accepted.
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("my_service.internal"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("a-b.example.com"))
    }

    func testIsValidHostnamePatternRejectsBadShapes() {
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern(""))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("   "))
        // Empty labels.
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("."))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern(".com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("example."))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("a..b"))
        // Wildcard misuse.
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("**"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("*."))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("*foo.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("foo.*.com"))
        // Leading/trailing dash in a label.
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("-foo.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("foo-.com"))
        // Disallowed characters.
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("foo bar.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("foo:8080"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("https://foo.com"))
    }
}
