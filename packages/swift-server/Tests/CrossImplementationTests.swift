import XCTest
@testable import slicc_server

/// Pinned cross-implementation mask vectors.
///
/// The same vectors are pinned in
/// `packages/shared/tests/cross-impl-vectors.test.ts`. The hex strings
/// here come from `node packages/dev-tools/tools/gen-mask-vectors.mjs`
/// (the canonical TS implementation in @slicc/shared).
///
/// Regenerate with:
///   npm run build -w @slicc/shared
///   node packages/dev-tools/tools/gen-mask-vectors.mjs
///
/// Update BOTH this file and the TS sibling whenever the masking
/// algorithm changes intentionally. A drift between implementations
/// causes silent unmask failures in the fetch proxy.
final class CrossImplementationTests: XCTestCase {
    private struct Vector {
        let sessionId: String
        let name: String
        let value: String
        let expected: String
    }

    private static let vectors: [Vector] = [
        Vector(
            sessionId: "session-cross-impl-1",
            name: "GITHUB_TOKEN",
            value: "ghp_realToken123",
            expected: "ghp_25243876bf81"
        ),
        Vector(
            sessionId: "session-cross-impl-2",
            name: "AWS_KEY",
            value: "AKIAEXAMPLE",
            expected: "AKIAc418a4f"
        ),
        Vector(
            sessionId: "",
            name: "X",
            value: "",
            expected: ""
        ),
        Vector(
            sessionId: "session-😀",
            name: "Y",
            value: "value with spaces",
            expected: "3a7af4ae08a5ccb55"
        ),
    ]

    func testMaskMatchesPinnedVectors() {
        for v in Self.vectors {
            let result = mask(
                sessionId: v.sessionId,
                secretName: v.name,
                realValue: v.value
            )
            XCTAssertEqual(
                result,
                v.expected,
                "mask mismatch for (sessionId: \(v.sessionId), name: \(v.name))"
            )
        }
    }
}
