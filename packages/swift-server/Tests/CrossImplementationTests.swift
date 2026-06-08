import XCTest
@testable import slicc_server

/// Pinned cross-implementation mask vectors.
///
/// The same vectors are pinned in
/// `packages/shared-ts/tests/cross-impl-vectors.test.ts`. The hex strings
/// here come from `node packages/dev-tools/tools/gen-mask-vectors.mjs`
/// (the canonical TS implementation in @slicc/shared-ts).
///
/// Regenerate with:
///   npm run build -w @slicc/shared-ts
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
        // Pin the UTF-16 code-unit length contract. `tok🎉end` is 8 UTF-16
        // code units (emoji = surrogate pair) but 7 grapheme clusters.
        // Swift's `mask` uses `.utf16.count` to match JS `String.length`;
        // this vector catches a regression to `String.count` (graphemes).
        Vector(
            sessionId: "session-utf16",
            name: "EMOJI_VALUE",
            value: "tok🎉end",
            expected: "d2317bc7"
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

    // MARK: - CDP frame unmask parity (mirrors packages/shared-ts/tests/cdp-frame-unmask.test.ts)
    //
    // Pins the same fixture (sessionId='session-fixed', API_KEY='sk-realValue123'
    // gated on example.com) and the same per-method output as the TS helper.
    // The wrapper JSON's key order is not part of the contract — we compare the
    // re-parsed params field. The masked → real substring substitution itself
    // is byte-identical across implementations (same HMAC mask + plain
    // String/Data replace).

    private static let frameSessionId = "session-fixed"
    private static let frameSecret = SecretInjector.LoadedSecret(
        name: "API_KEY",
        realValue: "sk-realValue123",
        maskedValue: mask(sessionId: "session-fixed", secretName: "API_KEY", realValue: "sk-realValue123"),
        domains: ["example.com"]
    )

    private func frameInjector() -> SecretInjector {
        SecretInjector(secrets: [Self.frameSecret])
    }

    func testCdpFrameUnmaskRuntimeEvaluateInDomain() throws {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"id":1,"sessionId":"S1","method":"Runtime.evaluate","params":{"expression":"submit(\#(masked))","returnByValue":true}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in "https://example.com/" }
        )
        let parsed = try XCTUnwrap(out.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] })
        XCTAssertEqual(parsed["id"] as? Int, 1)
        XCTAssertEqual(parsed["sessionId"] as? String, "S1")
        let params = parsed["params"] as? [String: Any]
        XCTAssertEqual(params?["expression"] as? String, "submit(sk-realValue123)")
        XCTAssertEqual(params?["returnByValue"] as? Bool, true)
    }

    func testCdpFrameUnmaskRuntimeEvaluateOutOfDomain() {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"sessionId":"S1","method":"Runtime.evaluate","params":{"expression":"submit(\#(masked))"}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in "https://evil.example.org/" }
        )
        XCTAssertNil(out, "out-of-domain frames must be untouched (nil → passthrough)")
    }

    func testCdpFrameUnmaskInsertTextInDomain() throws {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"sessionId":"S1","method":"Input.insertText","params":{"text":"\#(masked)"}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in "https://example.com/" }
        )
        let parsed = try XCTUnwrap(out.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] })
        let params = parsed["params"] as? [String: Any]
        XCTAssertEqual(params?["text"] as? String, "sk-realValue123")
    }

    func testCdpFrameUnmaskCallFunctionOnStringArgsOnly() throws {
        let masked = Self.frameSecret.maskedValue
        let argsJSON = "[{\"value\":\"\(masked)\"},{\"value\":42},{\"objectId\":\"obj-1\"},"
            + "{\"value\":\"prefix \(masked) suffix\"}]"
        let paramsJSON = "{\"functionDeclaration\":\"function(v){this.value=v}\"," + "\"arguments\":\(argsJSON)}"
        let frame = "{\"sessionId\":\"S1\",\"method\":\"Runtime.callFunctionOn\",\"params\":\(paramsJSON)}"
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in "https://example.com/" }
        )
        let parsed = try XCTUnwrap(out.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] })
        let params = parsed["params"] as? [String: Any]
        let args = params?["arguments"] as? [[String: Any]]
        XCTAssertEqual(args?[0]["value"] as? String, "sk-realValue123")
        XCTAssertEqual(args?[1]["value"] as? Int, 42)
        XCTAssertEqual(args?[2]["objectId"] as? String, "obj-1")
        XCTAssertEqual(args?[3]["value"] as? String, "prefix sk-realValue123 suffix")
    }

    func testCdpFrameUnmaskUnrelatedMethodPassesThrough() {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"sessionId":"S1","method":"Input.dispatchKeyEvent","params":{"type":"char","text":"\#(masked)"}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in "https://example.com/" }
        )
        XCTAssertNil(out, "unrelated methods must be untouched (nil → passthrough)")
    }

    func testCdpFrameUnmaskFailsClosedWhenURLUnavailable() {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"sessionId":"S1","method":"Runtime.evaluate","params":{"expression":"submit(\#(masked))"}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: self.frameInjector(),
            urlForSession: { _ in nil }
        )
        XCTAssertNil(out, "unresolved URL must fail closed (nil → passthrough)")
    }

    func testCdpFrameUnmaskEmptyInjectorIsNoOp() {
        let masked = Self.frameSecret.maskedValue
        let frame = #"{"sessionId":"S1","method":"Runtime.evaluate","params":{"expression":"submit(\#(masked))"}}"#
        let out = CDPProxy.unmaskClientFrame(
            text: frame,
            injector: SecretInjector(secrets: []),
            urlForSession: { _ in "https://example.com/" }
        )
        XCTAssertNil(out, "empty injector must be a no-op")
    }
}
