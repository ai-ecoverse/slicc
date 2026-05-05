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

}
