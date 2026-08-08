import Foundation
import XCTest

@testable import SliccTrayFollower

/// The `fs.*` wire types: every request op, every response-data variant, the
/// `success`/`failure` factory statics, the `op`/`path` accessors, the encoded
/// shape, and the unknown-discriminator throwing paths.
final class TrayFsTests: XCTestCase {

    // MARK: - Encodings

    func testReadEncodingRawValues() {
        XCTAssertEqual(TrayFsReadEncoding.utf8.rawValue, "utf-8")
        XCTAssertEqual(TrayFsReadEncoding.binary.rawValue, "binary")
    }

    func testWriteEncodingRawValues() {
        XCTAssertEqual(TrayFsWriteEncoding.utf8.rawValue, "utf-8")
        XCTAssertEqual(TrayFsWriteEncoding.base64.rawValue, "base64")
    }

    // MARK: - Requests

    func testEveryRequestOpRoundTrips() throws {
        let requests: [TrayFsRequest] = [
            .readFile(path: "/a", encoding: .utf8),
            .readFile(path: "/a", encoding: nil),
            .writeFile(path: "/a", content: "hi", encoding: .base64),
            .stat(path: "/a"),
            .readDir(path: "/dir"),
            .mkdir(path: "/dir", recursive: true),
            .mkdir(path: "/dir", recursive: nil),
            .rm(path: "/dir", recursive: false),
            .exists(path: "/a"),
            .walk(path: "/dir"),
        ]
        for request in requests {
            XCTAssertEqual(try WireCodec.roundTrip(request), request, "round-trip failed for op \(request.op)")
        }
    }

    func testRequestOpDiscriminators() {
        XCTAssertEqual(TrayFsRequest.readFile(path: "/a", encoding: nil).op, "readFile")
        XCTAssertEqual(TrayFsRequest.writeFile(path: "/a", content: "c", encoding: .utf8).op, "writeFile")
        XCTAssertEqual(TrayFsRequest.stat(path: "/a").op, "stat")
        XCTAssertEqual(TrayFsRequest.readDir(path: "/a").op, "readDir")
        XCTAssertEqual(TrayFsRequest.mkdir(path: "/a", recursive: nil).op, "mkdir")
        XCTAssertEqual(TrayFsRequest.rm(path: "/a", recursive: nil).op, "rm")
        XCTAssertEqual(TrayFsRequest.exists(path: "/a").op, "exists")
        XCTAssertEqual(TrayFsRequest.walk(path: "/a").op, "walk")
    }

    func testRequestPathAccessorAcrossOps() {
        XCTAssertEqual(TrayFsRequest.readFile(path: "/r", encoding: nil).path, "/r")
        XCTAssertEqual(TrayFsRequest.writeFile(path: "/w", content: "c", encoding: .utf8).path, "/w")
        XCTAssertEqual(TrayFsRequest.stat(path: "/s").path, "/s")
        XCTAssertEqual(TrayFsRequest.mkdir(path: "/m", recursive: true).path, "/m")
        XCTAssertEqual(TrayFsRequest.walk(path: "/wk").path, "/wk")
    }

    func testWriteFileEncodesContentAndEncoding() throws {
        let json = try WireCodec.jsonString(TrayFsRequest.writeFile(path: "/a", content: "payload", encoding: .base64))
        XCTAssertTrue(json.contains("\"op\":\"writeFile\""))
        XCTAssertTrue(json.contains("\"content\":\"payload\""))
        XCTAssertTrue(json.contains("\"encoding\":\"base64\""))
    }

    func testStatRequestOmitsExtraKeys() throws {
        let json = try WireCodec.jsonString(TrayFsRequest.stat(path: "/a"))
        XCTAssertFalse(json.contains("content"))
        XCTAssertFalse(json.contains("recursive"))
    }

    func testUnknownRequestOpThrows() {
        XCTAssertThrowsError(try WireCodec.decode(TrayFsRequest.self, from: #"{"op":"chmod","path":"/a"}"#)) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }

    // MARK: - Response data

    func testNodeTypeRoundTrips() throws {
        for type in [TrayFsNodeType.file, .directory, .symlink] {
            XCTAssertEqual(try WireCodec.roundTrip(type), type)
        }
    }

    func testStatPayloadRoundTrip() throws {
        let stat = TrayFsStat(type: .file, size: 128, mtime: 1_700.5, ctime: 1_600.25)
        XCTAssertEqual(try WireCodec.roundTrip(stat), stat)
    }

    func testDirEntryRoundTrip() throws {
        let entry = TrayFsDirEntry(name: "child", type: .directory)
        XCTAssertEqual(try WireCodec.roundTrip(entry), entry)
    }

    func testEveryResponseDataVariantRoundTrips() throws {
        let variants: [TrayFsResponseData] = [
            .file(content: "hi", encoding: .utf8),
            .stat(TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 2)),
            .dirEntries([TrayFsDirEntry(name: "a", type: .file), TrayFsDirEntry(name: "b", type: .symlink)]),
            .exists(true),
            .exists(false),
            .paths(["/a", "/b/c"]),
            .void,
        ]
        for variant in variants {
            XCTAssertEqual(try WireCodec.roundTrip(variant), variant)
        }
    }

    func testUnknownResponseDataTypeThrows() {
        XCTAssertThrowsError(try WireCodec.decode(TrayFsResponseData.self, from: #"{"type":"symlinkTarget"}"#)) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }

    // MARK: - Response envelope + factories

    func testSuccessFactory() throws {
        let response = TrayFsResponse.success(.exists(true))
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.data, .exists(true))
        XCTAssertNil(response.error)
        XCTAssertEqual(try WireCodec.roundTrip(response), response)
    }

    func testFailureFactory() throws {
        let response = TrayFsResponse.failure("not found", code: "ENOENT")
        XCTAssertFalse(response.ok)
        XCTAssertNil(response.data)
        XCTAssertEqual(response.error, "not found")
        XCTAssertEqual(response.code, "ENOENT")
        XCTAssertEqual(try WireCodec.roundTrip(response), response)
    }

    func testFailureFactoryDefaultsCodeToNil() {
        let response = TrayFsResponse.failure("bad")
        XCTAssertNil(response.code)
    }

    func testChunkedFileResponseRoundTrip() throws {
        let response = TrayFsResponse(
            ok: true, data: .file(content: "slice", encoding: .base64), chunkIndex: 1, totalChunks: 3)
        XCTAssertEqual(try WireCodec.roundTrip(response), response)
    }
}
