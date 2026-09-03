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

    // MARK: - Request content-type parity (mirrors the table in
    // packages/shared-ts/tests/cross-impl-vectors.test.ts)
    //
    // Node's fetch proxy and this one must agree on which request bodies get a
    // masked→real unmask pass; when they drift, a form POST that works on
    // Sliccstart ships the masked token upstream on the Node CLI (#2821).

    private static let requestContentTypeTable: [(contentType: String, isText: Bool)] = [
        ("application/x-www-form-urlencoded", true),
        ("application/x-www-form-urlencoded;charset=UTF-8", true),
        ("Application/X-WWW-Form-Urlencoded", true),
        ("application/json", true),
        ("application/json; charset=utf-8", true),
        ("text/plain", true),
        ("application/xml", true),
        ("image/svg+xml", true),
        ("application/javascript", true),
        ("application/ecmascript", true),
        ("text/html", true),
        ("text/css", true),
        // Unlabeled bodies are binary on both floats: the byte-safe unmask path
        // handles them without a lossy UTF-8 round-trip.
        ("", false),
        ("image/jpeg", false),
        ("application/octet-stream", false),
        ("application/pdf", false),
        ("multipart/form-data; boundary=x", false),
        ("application/x-git-receive-pack-request", false),
    ]

    func testIsTextRequestContentTypeMatchesPinnedTable() {
        for row in Self.requestContentTypeTable {
            XCTAssertEqual(
                isTextRequestContentType(row.contentType),
                row.isText,
                "request content-type classification drift for \(row.contentType.isEmpty ? "(empty)" : row.contentType)"
            )
        }
    }

    // MARK: - Form-body unmask parity (mirrors the table in
    // packages/shared-ts/tests/cross-impl-vectors.test.ts)
    //
    // Both floats must percent-encode a substituted secret identically. The real
    // value carries every form-reserved character, so a drift in either the
    // encoder's allowed set or the field walk changes an expected string.
    // `%MASKED%` stands for the masked token, derived from the pinned `mask()`.

    private static let formSessionId = "session-form-parity"
    private static let formReal = "ab+cd/ef=gh&ij kl%mn"
    private static let formEncoded = "ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn"

    private static let formBodyTable: [(input: String, expected: String)] = [
        (
            "token=%MASKED%&grant_type=client_credentials",
            "token=\(formEncoded)&grant_type=client_credentials"
        ),
        ("%MASKED%", formEncoded),
        ("a=%MASKED%&b=keep&c=%MASKED%", "a=\(formEncoded)&b=keep&c=\(formEncoded)"),
        // No masked token: forwarded byte-identical, `+` and `%2F` untouched.
        ("a=1&b=hello+world&c=%2Fpath", "a=1&b=hello+world&c=%2Fpath"),
        ("a=&b=", "a=&b="),
    ]

    func testUnmaskFormBodyMatchesPinnedTable() {
        let masked = mask(
            sessionId: Self.formSessionId,
            secretName: "FORM_SECRET",
            realValue: Self.formReal
        )
        let injector = SecretInjector(secrets: [
            SecretInjector.LoadedSecret(
                name: "FORM_SECRET",
                realValue: Self.formReal,
                maskedValue: masked,
                domains: ["api.example.com"]
            )
        ])
        for row in Self.formBodyTable {
            let body = row.input.replacingOccurrences(of: "%MASKED%", with: masked)
            XCTAssertEqual(
                unmaskFormBody(text: body, hostname: "api.example.com", injector: injector),
                row.expected,
                "form-body unmask drift for \(row.input)"
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
        let argsJSON =
            "[{\"value\":\"\(masked)\"},{\"value\":42},{\"objectId\":\"obj-1\"},"
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

    // MARK: - Response content-type parity (mirrors the table in
    // packages/shared-ts/tests/content-type-parity.test.ts)
    //
    // `/api/fetch-proxy` scrubs real secret values out of an upstream body only
    // when the body is UTF-8 text. Node decides that with shared-ts
    // `isTextContentType`; this float must agree, or an `application/xml` reply
    // hands the agent a real secret on Sliccstart that the Node CLI masks
    // (#2822). The `charset=` rows are the regression guard for the dropped
    // catch-all that used to force binary bodies through a `String` round-trip.

    private static let responseContentTypeTable: [(contentType: String, isText: Bool)] = [
        ("text/plain", true),
        ("text/html", true),
        ("text/html; charset=utf-8", true),
        ("text/css", true),
        ("text/event-stream", true),
        ("application/json", true),
        ("application/json; charset=utf-8", true),
        ("application/xml", true),
        ("application/xhtml+xml", true),
        ("application/javascript", true),
        ("application/ecmascript", true),
        ("image/svg+xml", true),
        ("Application/JSON", true),
        ("", false),
        ("image/jpeg", false),
        ("image/png", false),
        ("application/octet-stream", false),
        ("application/octet-stream; charset=utf-8", false),
        ("application/pdf", false),
        ("application/zip", false),
        ("audio/mpeg", false),
        ("video/mp4", false),
        // Response-side only: a form body is not text here. The request hop has
        // its own predicate because form POSTs carry secrets that must unmask.
        ("application/x-www-form-urlencoded", false),
    ]

    func testIsTextContentTypeMatchesPinnedTable() {
        for row in Self.responseContentTypeTable {
            XCTAssertEqual(
                isTextContentType(row.contentType),
                row.isText,
                "response content-type classification drift for "
                    + (row.contentType.isEmpty ? "(empty)" : row.contentType)
            )
        }
    }
}
