import XCTest

@testable import slicc_server




final class RawFetchProtocolTests: XCTestCase {
    private func pairs(_ list: [(String, String)]) -> RawHeaderList {
        list.map { RawHeaderPair($0.0, $0.1) }
    }

    func testOffersOnlyTheCodingsTheClientDecodes() {
        XCTAssertEqual(RawFetchProtocol.acceptEncoding(for: pairs([("user-agent", "curl")])), "gzip, deflate")
    }

    
    
    func testARangedRequestSpellsOutIdentity() {
        XCTAssertEqual(RawFetchProtocol.acceptEncoding(for: pairs([("range", "bytes=0-9")])), "identity")
        XCTAssertEqual(RawFetchProtocol.acceptEncoding(for: pairs([("if-range", "\"v1\"")])), "identity")
    }

    
    func testClassifiesWhatTheClientDidToTheBody() {
        let cases: [([(String, String)], RawFetchProtocol.UpstreamDecoding)] = [
            ([], .untouched),
            ([("content-encoding", "br")], .untouched),
            ([("content-encoding", "identity, gzip")], .untouched),
            ([("content-encoding", "GZIP")], .decoded),
            ([("content-encoding", "deflate")], .decoded),
            ([("content-encoding", "gzip, identity")], .decoded),
            ([("content-encoding", "gzip, br")], .partiallyDecoded),
            ([("content-encoding", "gzip"), ("content-encoding", "gzip")], .partiallyDecoded),
        ]
        for (headers, expected) in cases {
            XCTAssertEqual(RawFetchProtocol.upstreamDecoding(pairs(headers)), expected, "\(headers)")
        }
    }

    func testRefusesOnlyADecodedPartialResponse() {
        let gzip = pairs([("content-encoding", "gzip")])
        let codings = RawFetchProtocol.decodedCodings
        XCTAssertTrue(RawFetchProtocol.isDecodedPartialResponse(status: 206, headers: gzip, decodedCodings: codings))
        XCTAssertFalse(RawFetchProtocol.isDecodedPartialResponse(status: 206, headers: gzip, decodedCodings: []))
        XCTAssertFalse(RawFetchProtocol.isDecodedPartialResponse(status: 200, headers: gzip, decodedCodings: codings))
    }

    func testProbeReplyNamesTheProtocolAndTheCap() throws {
        let data = Data(RawFetchProtocol.probeReplyJSON(maxRequestBodyBytes: 42).utf8)
        let reply = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(reply["rawFetch"] as? Int, 1)
        XCTAssertEqual(reply["requestBodyStreaming"] as? Bool, true)
        XCTAssertEqual(reply["maxRequestBodyBytes"] as? Int, 42)
    }
}
