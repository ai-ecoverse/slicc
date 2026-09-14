import XCTest

@testable import Sliccstart






final class SecretNameValidatorTests: XCTestCase {

    func testAcceptsAlphanumerics() {
        XCTAssertTrue(SecretNameValidator.isValid("token"))
        XCTAssertTrue(SecretNameValidator.isValid("TOKEN"))
        XCTAssertTrue(SecretNameValidator.isValid("Token123"))
        XCTAssertTrue(SecretNameValidator.isValid("X"))
        XCTAssertTrue(SecretNameValidator.isValid("abc123XYZ"))
    }

    func testAcceptsDotsForMountProfileKeyShape() {
        
        
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
        
        
        
        
        
        
        XCTAssertFalse(SecretNameValidator.isValid("café"))  
        XCTAssertFalse(SecretNameValidator.isValid("s3.р2.access_key_id"))  
        XCTAssertFalse(SecretNameValidator.isValid("数字"))  
        XCTAssertFalse(SecretNameValidator.isValid("token\u{0661}"))  
        XCTAssertFalse(SecretNameValidator.isValid("token\u{FF11}"))  
        XCTAssertFalse(SecretNameValidator.isValid("Ω"))  
    }

    
    
    
    
    
    
    
    
    func testValidatorMatchesServerProfileNameSpec() {
        let cases: [(String, Bool)] = [
            
            ("default", true),
            ("dev-1", true),
            ("team.us_west", true),
            ("ABC123", true),
            ("s3.r2.access_key_id", true),
            
            ("", false),
            ("foo/bar", false),
            ("../etc", false),
            ("foo bar", false),
            ("foo;rm", false),
            
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
