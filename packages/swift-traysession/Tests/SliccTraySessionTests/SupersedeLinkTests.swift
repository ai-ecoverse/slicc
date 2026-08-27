import Foundation
import XCTest

@testable import SliccTraySession

/// Pinned cross-implementation `successor-version` link vectors (#1957).
///
/// The same table is pinned in:
///   - `packages/shared-ts/tests/successor-version-link.test.ts`
///   - `packages/slicc-cli/internal/signaling/link_test.go`
///   - `packages/swift-trayfollower/Tests/SliccTrayFollowerTests/SupersedeLinkTests.swift`
///
/// Four followers parse this header, and a disagreement between them is exactly
/// the class of bug #1956 was: one implementation reads a redirect everyone
/// else follows, dead-ends, and nobody notices until a leader reconnects in the
/// field. Add a case here and to all three siblings, never to just one.
final class SupersedeLinkTests: XCTestCase {

    private struct Vector {
        let name: String
        let header: String?
        let expected: String?
    }

    private let vectors: [Vector] = [
        Vector(
            name: "the header the worker emits",
            header: #"<https://www.sliccy.ai/join/fresh-tray.deadbeef>; rel="successor-version""#,
            expected: "https://www.sliccy.ai/join/fresh-tray.deadbeef"),
        Vector(
            name: "buried in the standard rel set applySliccLinks appends",
            header: #"<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version", "#
                + #"<https://www.sliccy.ai/.well-known/api-catalog>; rel="api-catalog", "#
                + #"<https://www.sliccy.ai/status>; rel="status"; type="application/json""#,
            expected: "https://www.sliccy.ai/join/fresh.beef"),
        Vector(
            name: "standard rel set first, successor last",
            header: #"<https://www.sliccy.ai/status>; rel="status", "#
                + #"<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version""#,
            expected: "https://www.sliccy.ai/join/fresh.beef"),
        Vector(
            name: "unquoted rel token",
            header: #"<https://www.sliccy.ai/join/a.b>; rel=successor-version"#,
            expected: "https://www.sliccy.ai/join/a.b"),
        Vector(
            name: "rel as a space-separated token list",
            header: #"<https://www.sliccy.ai/join/a.b>; rel="alternate successor-version""#,
            expected: "https://www.sliccy.ai/join/a.b"),
        Vector(
            name: "rel matching is case-insensitive (RFC 8288 3.3)",
            header: #"<https://www.sliccy.ai/join/a.b>; REL="Successor-Version""#,
            expected: "https://www.sliccy.ai/join/a.b"),
        Vector(
            name: "a comma inside a quoted parameter is not a value separator",
            header: #"<https://www.sliccy.ai/x>; rel="alternate"; title="one, two", "#
                + #"<https://www.sliccy.ai/join/a.b>; rel="successor-version""#,
            expected: "https://www.sliccy.ai/join/a.b"),
        Vector(
            name: "a semicolon inside a quoted parameter does not forge a rel",
            header: #"<https://www.sliccy.ai/x>; title="q; rel=successor-version""#,
            expected: nil),
        Vector(
            name: "a different version rel is not a successor",
            header: #"<https://www.sliccy.ai/join/old.b>; rel="predecessor-version""#,
            expected: nil),
        Vector(
            name: "successor-version as a prefix of another token does not match",
            header: #"<https://www.sliccy.ai/join/a.b>; rel="successor-version-2""#,
            expected: nil),
        Vector(
            name: "a relative target is rejected — a replacement tray is always absolute",
            header: #"</join/a.b>; rel="successor-version""#,
            expected: nil),
        Vector(
            name: "a percent-encoded target survives verbatim",
            header:
                #"<https://www.sliccy.ai/join/fresh%3Eevil.deadbeef>; rel="successor-version""#,
            expected: "https://www.sliccy.ai/join/fresh%3Eevil.deadbeef"),
        Vector(name: "no header at all", header: nil, expected: nil),
        Vector(name: "an empty header", header: "", expected: nil),
        Vector(name: "a garbage header", header: "not a link header", expected: nil),
    ]

    func testPinnedVectors() {
        for vector in vectors {
            XCTAssertEqual(
                SupersedeLink.successor(in: vector.header)?.absoluteString, vector.expected,
                vector.name)
        }
    }

    func testMergesRepeatedHeaderInstances() {
        // URLSession folds repeated instances into one comma-joined value;
        // some platforms use a newline instead.
        let link = #"<https://www.sliccy.ai/join/a.b>; rel="successor-version""#
        let other = #"<https://www.sliccy.ai/status>; rel="status""#
        XCTAssertEqual(
            SupersedeLink.successor(in: "\(other), \(link)")?.absoluteString,
            "https://www.sliccy.ai/join/a.b")
        XCTAssertEqual(
            SupersedeLink.successor(in: "\(other)\n\(link)")?.absoluteString,
            "https://www.sliccy.ai/join/a.b")
    }

    func testReturnsTheFirstOfSeveral() {
        let header =
            #"<https://www.sliccy.ai/join/first.b>; rel="successor-version", "#
            + #"<https://www.sliccy.ai/join/second.b>; rel="successor-version""#
        XCTAssertEqual(
            SupersedeLink.successor(in: header)?.absoluteString,
            "https://www.sliccy.ai/join/first.b")
    }

    func testReadsTheLinkOffAnHTTPResponse() {
        let response = HTTPURLResponse(
            url: URL(string: "https://www.sliccy.ai/join/old.b")!,
            statusCode: 409,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Link": #"<https://www.sliccy.ai/join/a.b>; rel="successor-version""#
            ])!
        XCTAssertEqual(
            SupersedeLink.successor(in: response)?.absoluteString,
            "https://www.sliccy.ai/join/a.b")
    }
}
