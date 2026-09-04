import XCTest

@testable import slicc_server

/// Overlay CSP-strip Fetch proxy POST-body recovery (#2886). Mirrors the
/// `decodeCdpRequestPostBody` cases in node-server's
/// `packages/node-server/tests/electron-controller.test.ts` so both floats
/// forward the same bytes for the same intercepted document POST.
final class OverlayPostBodyTests: XCTestCase {
    private static let jpegSOI = Data([0xff, 0xd8, 0xff, 0x98, 0x00, 0x41, 0x7f, 0x80, 0xfe])
    private static let allBytes = Data((0...255).map { UInt8($0) })

    func testRecoversEveryByteFromPostDataEntries() {
        let result = decodeCdpRequestPostBody(request: [
            "hasPostData": true,
            "postDataEntries": [["bytes": Self.allBytes.base64EncodedString()]],
        ])
        // The old `.utf8` hop expanded this to 384 bytes.
        XCTAssertEqual(result, .bytes(Self.allBytes))
        guard case .bytes(let data) = result else { return XCTFail("expected bytes") }
        XCTAssertEqual(data.count, 256)
    }

    func testConcatenatesMultipartEntriesInOrder() {
        let head = Data("--b\r\nContent-Disposition: form-data; name=\"f\"\r\n\r\n".utf8)
        let tail = Data("\r\n--b--\r\n".utf8)
        let result = decodeCdpRequestPostBody(request: [
            "hasPostData": true,
            "postDataEntries": [
                ["bytes": head.base64EncodedString()],
                ["bytes": Self.jpegSOI.base64EncodedString()],
                ["bytes": tail.base64EncodedString()],
            ],
        ])
        XCTAssertEqual(result, .bytes(head + Self.jpegSOI + tail))
    }

    func testPrefersPostDataEntriesOverLossyPostDataString() {
        let latin1 = String(Self.jpegSOI.map { Character(UnicodeScalar($0)) })
        let result = decodeCdpRequestPostBody(request: [
            "postData": latin1,
            "hasPostData": true,
            "postDataEntries": [["bytes": Self.jpegSOI.base64EncodedString()]],
        ])
        XCTAssertEqual(result, .bytes(Self.jpegSOI))
    }

    func testAcceptsAsciiPostDataString() {
        let body = "name=ada&note=hello+world%C3%A9"
        let result = decodeCdpRequestPostBody(request: ["postData": body, "hasPostData": true])
        XCTAssertEqual(result, .bytes(Data(body.utf8)))
    }

    /// A latin1 body that also happens to be valid base64 must NOT be decoded as
    /// base64 — that was the Swift-only second failure mode of #2886.
    func testDoesNotDecodeABase64ShapedBodyAsBase64() {
        let body = "abcd"  // valid base64 for `69 b7 1d`
        let result = decodeCdpRequestPostBody(request: ["postData": body, "hasPostData": true])
        XCTAssertEqual(result, .bytes(Data("abcd".utf8)))
    }

    func testRefusesNonAsciiPostDataString() {
        let latin1 = String(Self.jpegSOI.map { Character(UnicodeScalar($0)) })
        guard case .unrecoverable = decodeCdpRequestPostBody(request: ["postData": latin1, "hasPostData": true])
        else { return XCTFail("expected unrecoverable") }
    }

    func testRefusesFileEntryWithoutBytes() {
        let head = Data("--b\r\n".utf8)
        let result = decodeCdpRequestPostBody(request: [
            "hasPostData": true,
            "postDataEntries": [["bytes": head.base64EncodedString()], [String: Any]()],
        ])
        guard case .unrecoverable = result else { return XCTFail("expected unrecoverable") }
    }

    func testRefusesHasPostDataWithNoBodyAndPassesBodylessNavigation() {
        guard case .unrecoverable = decodeCdpRequestPostBody(request: ["hasPostData": true]) else {
            return XCTFail("expected unrecoverable")
        }
        XCTAssertEqual(decodeCdpRequestPostBody(request: [:]), .none)
        XCTAssertEqual(decodeCdpRequestPostBody(request: ["postData": "", "hasPostData": false]), .none)
    }
}
