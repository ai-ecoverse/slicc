import XCTest

@testable import slicc_server

final class EnvFileFormatTests: XCTestCase {

    func testParseSkipsBlankLinesAndComments() {
        let blob = """

            # this is a comment
            FOO=bar

            # another comment
            BAZ=qux
            """
        let entries = EnvFileFormat.parse(blob)
        XCTAssertEqual(entries.map(\.key), ["FOO", "BAZ"])
        XCTAssertEqual(entries.map(\.value), ["bar", "qux"])
    }

    func testParseStripsMatchingDoubleQuotesAndUnescapes() {
        let entries = EnvFileFormat.parse(#"GREETING="hello \"world\"""#)
        XCTAssertEqual(entries.first?.value, #"hello "world""#)
    }

    func testParseStripsMatchingSingleQuotes() {
        let entries = EnvFileFormat.parse("MSG='hi there'")
        XCTAssertEqual(entries.first?.value, "hi there")
    }

    func testParseSkipsLinesWithoutEquals() {
        let entries = EnvFileFormat.parse("not_a_pair\nFOO=bar")
        XCTAssertEqual(entries.map(\.key), ["FOO"])
    }

    func testSerializeQuotesValuesWithSpacesOrSpecialChars() throws {
        let blob = try EnvFileFormat.serialize([
            EnvEntry(key: "PLAIN", value: "hello"),
            EnvEntry(key: "SPACED", value: "hello world"),
            EnvEntry(key: "HASH", value: "abc#def"),
            EnvEntry(key: "QUOTED", value: #"v"x"#),
        ])
        XCTAssertTrue(blob.contains("PLAIN=hello\n"))
        XCTAssertTrue(blob.contains(#"SPACED="hello world""#))
        XCTAssertTrue(blob.contains(#"HASH="abc#def""#))
        XCTAssertTrue(blob.contains(#"QUOTED="v\"x""#))
    }

    func testSecretsBlobRoundTrip() throws {
        let original = [
            Secret(name: "GITHUB_TOKEN", value: "ghp_abc", domains: ["api.github.com", "*.github.com"]),
            Secret(name: "OPENAI_KEY", value: "sk-xyz", domains: ["api.openai.com"]),
        ]
        let blob = try EnvFileFormat.blobFromSecrets(original)
        let parsed = EnvFileFormat.secretsFromBlob(blob)
        XCTAssertEqual(parsed, original)
    }

    func testSecretsBlobPreservesQuotedValues() throws {
        let original = [
            Secret(name: "TOKEN", value: #"value with "quotes" and #hash"#, domains: ["a.com"])
        ]
        let blob = try EnvFileFormat.blobFromSecrets(original)
        let parsed = EnvFileFormat.secretsFromBlob(blob)
        XCTAssertEqual(parsed, original)
    }

    func testSecretsFromBlobSkipsKeysWithoutDomains() {
        let blob = """
            ORPHAN=value-no-domains
            VALID=v
            VALID_DOMAINS=a.com
            """
        let secrets = EnvFileFormat.secretsFromBlob(blob)
        XCTAssertEqual(secrets.count, 1)
        XCTAssertEqual(secrets.first?.name, "VALID")
    }

    func testSecretsFromBlobSkipsEmptyDomainsList() {
        let blob = """
            EMPTY=v
            EMPTY_DOMAINS=
            """
        XCTAssertTrue(EnvFileFormat.secretsFromBlob(blob).isEmpty)
    }

    func testSecretsFromBlobAcceptsAnyDeclarationOrder() {
        let blob = """
            TOKEN_DOMAINS=api.example.com
            TOKEN=hello
            """
        let secrets = EnvFileFormat.secretsFromBlob(blob)
        XCTAssertEqual(secrets, [Secret(name: "TOKEN", value: "hello", domains: ["api.example.com"])])
    }

    func testSerializeRejectsMultilineValue() {
        let pem = "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----"
        XCTAssertThrowsError(try EnvFileFormat.serialize([EnvEntry(key: "PEM", value: pem)])) { error in
            XCTAssertEqual(error as? SecretStoreError, .multilineValue(name: "PEM"))
            XCTAssertEqual(
                (error as? SecretStoreError)?.errorDescription,
                EnvFileFormat.multilineValueError("PEM")
            )
        }
    }

    func testSerializeRejectsCarriageReturnValue() {
        XCTAssertThrowsError(try EnvFileFormat.serialize([EnvEntry(key: "CRLF", value: "a\r\nb")])) { error in
            XCTAssertEqual(error as? SecretStoreError, .multilineValue(name: "CRLF"))
        }
    }

    func testBlobFromSecretsRejectsMultilineValue() {
        let secrets = [Secret(name: "PEM", value: "line1\nline2", domains: ["a.com"])]
        XCTAssertThrowsError(try EnvFileFormat.blobFromSecrets(secrets)) { error in
            XCTAssertEqual(error as? SecretStoreError, .multilineValue(name: "PEM"))
        }
    }

    func testMultilineValueWouldNotRoundTrip() {
        let parsed = EnvFileFormat.parse("PEM=\"line1\nline2\"\nPEM_DOMAINS=a.com\n")
        XCTAssertEqual(parsed.first?.value, "\"line1")
        XCTAssertFalse(parsed.contains { $0.value.contains("line2") })
    }
}
