import XCTest
@testable import Sliccstart

/// Pins the character set the Settings → Secrets editor accepts. Must
/// stay aligned with `SignAndForward.isValidProfileName` in the
/// swift-server target — the UI accepts the same set the server accepts
/// for the profile portion of an `s3.<profile>.<field>` key, so users
/// can't enter a name the server would later reject.
final class SecretNameValidatorTests: XCTestCase {

    func testAcceptsAlphanumerics() {
        XCTAssertTrue(SecretNameValidator.isValid("token"))
        XCTAssertTrue(SecretNameValidator.isValid("TOKEN"))
        XCTAssertTrue(SecretNameValidator.isValid("Token123"))
        XCTAssertTrue(SecretNameValidator.isValid("X"))
        XCTAssertTrue(SecretNameValidator.isValid("abc123XYZ"))
    }

    func testAcceptsDotsForMountProfileKeyShape() {
        // The motivating case: mount profile credentials are stored as
        // `s3.<profile>.<field>` and previously couldn't be entered at all.
        XCTAssertTrue(SecretNameValidator.isValid("s3.default.access_key_id"))
        XCTAssertTrue(SecretNameValidator.isValid("s3.r2.secret_access_key"))
        XCTAssertTrue(SecretNameValidator.isValid("s3.minio-prod.endpoint"))
    }

    func testAcceptsUnderscoresAndHyphens() {
        XCTAssertTrue(SecretNameValidator.isValid("AWS_ACCESS_KEY"))
        XCTAssertTrue(SecretNameValidator.isValid("gh-prod"))
        XCTAssertTrue(SecretNameValidator.isValid("a-b_c.d"))
    }

    func testRejectsEmpty() {
        XCTAssertFalse(SecretNameValidator.isValid(""))
    }

    func testRejectsWhitespace() {
        XCTAssertFalse(SecretNameValidator.isValid("foo bar"))
        XCTAssertFalse(SecretNameValidator.isValid("\t"))
    }

    func testRejectsShellMetacharacters() {
        XCTAssertFalse(SecretNameValidator.isValid("foo;rm"))
        XCTAssertFalse(SecretNameValidator.isValid("foo|bar"))
        XCTAssertFalse(SecretNameValidator.isValid("foo$bar"))
        XCTAssertFalse(SecretNameValidator.isValid("`foo`"))
        XCTAssertFalse(SecretNameValidator.isValid("foo&bar"))
    }

    func testRejectsPathSeparators() {
        XCTAssertFalse(SecretNameValidator.isValid("foo/bar"))
        XCTAssertFalse(SecretNameValidator.isValid("foo\\bar"))
    }

    func testRejectsAtAndOtherSymbols() {
        XCTAssertFalse(SecretNameValidator.isValid("user@host"))
        XCTAssertFalse(SecretNameValidator.isValid("foo:bar"))
        XCTAssertFalse(SecretNameValidator.isValid("foo!bar"))
        XCTAssertFalse(SecretNameValidator.isValid("foo#bar"))
    }

    func testRejectsNonAsciiAlphanumerics() {
        // A previous iteration used `CharacterSet.alphanumerics`, which is
        // Unicode-broad and silently accepted Cyrillic homoglyphs, CJK
        // ideographs, accented Latin, Arabic-Indic digits, full-width
        // digits, etc. — the kind of input the server-side ASCII check
        // rejects with `400 invalid_profile` after the UI has saved.
        // These cases pin the implementation to ASCII-only.
        XCTAssertFalse(SecretNameValidator.isValid("café"))                 // accented Latin
        XCTAssertFalse(SecretNameValidator.isValid("s3.р2.access_key_id"))  // Cyrillic 'р' (U+0440)
        XCTAssertFalse(SecretNameValidator.isValid("数字"))                   // CJK ideographs
        XCTAssertFalse(SecretNameValidator.isValid("token\u{0661}"))        // Arabic-Indic digit 1
        XCTAssertFalse(SecretNameValidator.isValid("token\u{FF11}"))        // full-width digit 1
        XCTAssertFalse(SecretNameValidator.isValid("Ω"))                    // Greek capital omega
    }

    /// Pinned corpus shared with the server-side validator's tests. Each
    /// row is `(input, expected)`. If this test fails on a particular
    /// row, the UI/server contract on that input has drifted — at least
    /// one side needs an update so they agree.
    ///
    /// The corpus reuses inputs from `SignAndForwardTests.swift`'s profile-name
    /// suite (`packages/swift-server/Tests/SignAndForwardTests.swift`) so
    /// the two test files visibly share vocabulary.
    func testValidatorMatchesServerProfileNameSpec() {
        let cases: [(String, Bool)] = [
            // Positives — exercised in SignAndForwardTests.testValidProfileName...
            ("default", true),
            ("dev-1", true),
            ("team.us_west", true),
            ("ABC123", true),
            ("s3.r2.access_key_id", true),
            // Negatives — exercised in SignAndForwardTests.testInvalidProfileName...
            ("", false),
            ("foo/bar", false),
            ("../etc", false),
            ("foo bar", false),
            ("foo;rm", false),
            // Unicode drift sentinels — UI must agree with server (both reject)
            ("s3.р2.x", false),
            ("\u{FF11}23", false),
        ]
        for (input, expected) in cases {
            let scalars = input.unicodeScalars
                .map { String(format: "U+%04X", $0.value) }
                .joined(separator: " ")
            XCTAssertEqual(
                SecretNameValidator.isValid(input), expected,
                "Drift on input \(input.debugDescription) (scalars: \(scalars))"
            )
        }
    }
}
