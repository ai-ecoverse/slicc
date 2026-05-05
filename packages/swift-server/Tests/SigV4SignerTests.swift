import XCTest
@testable import slicc_server

/// Canonical SigV4 v4 test vectors from AWS's official suite, mirrored from
/// `packages/node-server/tests/secrets/signing-s3.test.ts` and
/// `packages/webapp/tests/fs/mount/signing-s3.test.ts`. All three test files
/// exercise the same vectors against their respective copies of the signer
/// (see header in `SigV4Signer.swift` for why three copies exist). Drift
/// between any pair fails one of the suites.
///
/// Constants used by every case (per the AWS test-suite README):
///   - access key id: AKIDEXAMPLE
///   - secret access key: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
///   - region: us-east-1
///   - service: service (the suite is service-agnostic; not 's3', so our
///     impl skips the x-amz-content-sha256 header for these cases)
///   - now: 2015-08-30T12:36:00Z
///
/// The `Signature=...` strings asserted in the AWS-vector tests are the
/// AWS-published expected values. Changing any of the constants above
/// (region, service, credentials, date) invalidates the expected
/// signature — the test will then fail not because the signer is wrong
/// but because the inputs no longer match what AWS published.
final class SigV4SignerTests: XCTestCase {

    private let testCreds = SigV4Credentials(
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
    )
    private let testRegion = "us-east-1"
    private let testService = "service"

    private var testDate: Date {
        var components = DateComponents()
        components.year = 2015
        components.month = 8
        components.day = 30
        components.hour = 12
        components.minute = 36
        components.second = 0
        components.timeZone = TimeZone(identifier: "UTC")
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal.date(from: components)!
    }

    // MARK: - AWS canonical test vectors

    func testGetVanilla() {
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .GET,
                url: URL(string: "https://example.amazonaws.com/")!,
                headers: ["host": "example.amazonaws.com"]
            ),
            credentials: testCreds,
            region: testRegion,
            service: testService,
            now: testDate
        )
        XCTAssertEqual(
            signed.headers["Authorization"],
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                + "SignedHeaders=host;x-amz-date, "
                + "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        )
    }

    func testPostXWwwFormUrlencoded() {
        let body = Data("Param1=value1".utf8)
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .POST,
                url: URL(string: "https://example.amazonaws.com/")!,
                headers: [
                    "host": "example.amazonaws.com",
                    "content-type": "application/x-www-form-urlencoded",
                ],
                body: body
            ),
            credentials: testCreds,
            region: testRegion,
            service: testService,
            now: testDate
        )
        XCTAssertEqual(
            signed.headers["Authorization"],
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                + "SignedHeaders=content-type;host;x-amz-date, "
                + "Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a"
        )
    }

    // MARK: - Service-specific behavior

    func testAddsContentSha256HeaderWhenServiceIsS3() {
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .GET,
                url: URL(string: "https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt")!,
                headers: ["host": "my-bucket.s3.us-east-1.amazonaws.com"]
            ),
            credentials: testCreds,
            region: "us-east-1",
            service: "s3",
            now: testDate
        )
        XCTAssertEqual(
            signed.headers["x-amz-content-sha256"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        XCTAssertTrue(
            signed.headers["Authorization"]?.contains(
                "SignedHeaders=host;x-amz-content-sha256;x-amz-date"
            ) ?? false
        )
    }

    func testOmitsContentSha256ForNonS3Services() {
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .GET,
                url: URL(string: "https://example.amazonaws.com/")!,
                headers: ["host": "example.amazonaws.com"]
            ),
            credentials: testCreds,
            region: "us-east-1",
            service: "service",
            now: testDate
        )
        XCTAssertNil(signed.headers["x-amz-content-sha256"])
    }

    func testPassesSessionTokenAsSecurityToken() {
        let credsWithToken = SigV4Credentials(
            accessKeyId: testCreds.accessKeyId,
            secretAccessKey: testCreds.secretAccessKey,
            sessionToken: "TEMP-SESSION-TOKEN"
        )
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .GET,
                url: URL(string: "https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt")!,
                headers: ["host": "my-bucket.s3.us-east-1.amazonaws.com"]
            ),
            credentials: credsWithToken,
            region: "us-east-1",
            service: "s3",
            now: testDate
        )
        XCTAssertEqual(signed.headers["x-amz-security-token"], "TEMP-SESSION-TOKEN")
        XCTAssertTrue(
            signed.headers["Authorization"]?.contains("x-amz-security-token") ?? false
        )
    }

    func testHashesNonEmptyBodiesIntoContentSha256() {
        let body = Data("hello world".utf8)
        let signed = SigV4Signer.sign(
            SigV4Request(
                method: .PUT,
                url: URL(string: "https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt")!,
                headers: ["host": "my-bucket.s3.us-east-1.amazonaws.com"],
                body: body
            ),
            credentials: testCreds,
            region: "us-east-1",
            service: "s3",
            now: testDate
        )
        // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        XCTAssertEqual(
            signed.headers["x-amz-content-sha256"],
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        )
    }
}
