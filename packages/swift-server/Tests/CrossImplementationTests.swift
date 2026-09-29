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

    // MARK: - Multiline secret-value rejection parity (mirrors the table in
    // packages/shared-ts/tests/cross-impl-vectors.test.ts)
    //
    // The secret `.env` schema is line-oriented on both sides, so a value
    // carrying a line break cannot round-trip: it serializes with a real LF
    // inside its quotes and parses back as the truncated first line. Both
    // privileged servers refuse such a value at the boundary instead of
    // reporting success over a corrupted credential (#2828). If only one side
    // rejects, `POST /api/secrets` silently eats a PEM key on Sliccstart that
    // the Node CLI 400s (or the reverse) — the divergence this pairing exists
    // to prevent.

    private static let secretValueSingleLineTable: [(value: String, isSingleLine: Bool)] = [
        ("ghp_realToken123", true),
        ("", true),
        ("value with spaces", true),
        ("has#hash and \"quotes\"", true),
        ("tok🎉end", true),
        ("-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----", false),
        ("line1\nline2", false),
        ("trailing\n", false),
        ("\nleading", false),
        ("crlf\r\nvalue", false),
        ("bare\rreturn", false),
    ]

    func testSingleLineSecretValueMatchesPinnedTable() {
        for row in Self.secretValueSingleLineTable {
            XCTAssertEqual(
                EnvFileFormat.isSingleLineValue(row.value),
                row.isSingleLine,
                "secret-value line classification drift for \(row.value.debugDescription)"
            )
        }
    }

    /// The rejection message is part of the wire contract — both servers return
    /// it verbatim in the 400 body, so it is pinned alongside the predicate.
    func testMultilineValueErrorMessageIsPinned() {
        XCTAssertEqual(
            EnvFileFormat.multilineValueError("PEM_KEY"),
            "Secret \"PEM_KEY\" value cannot contain newlines; the secret store is "
                + "line-oriented and would truncate it to the first line"
        )
    }

    // MARK: - Secret-scope hostnames

    /// Pinned secret-scope hostnames, the same table as
    /// `packages/shared-ts/tests/cross-impl-vectors.test.ts`: the name a
    /// secret's domain list is matched against for a URL (lowercase, no port
    /// or userinfo, IDN in punycode, IPv6 bracketed).
    private static let scopeHostnames: [(String, String)] = [
        ("https://bücher.example:8443/x", "xn--bcher-kva.example"),
        ("https://u:p@BÜCHER.Example/", "xn--bcher-kva.example"),
        ("https://xn--bcher-kva.example/", "xn--bcher-kva.example"),
        ("https://API.GitHub.com/", "api.github.com"),
        ("http://upstream.test:65209/a", "upstream.test"),
        ("http://[::1]:5710/", "[::1]"),
    ]

    private static let scopeMatches: [(String, [String], Bool)] = [
        ("https://bücher.example/", ["xn--bcher-kva.example"], true),
        ("https://uploads.github.com:8443/", ["*.github.com"], true),
        ("https://github.com/", ["*.github.com"], false),
        ("https://x:y@upstream.test:65209/", ["upstream.test"], true),
        ("https://evil.test:8443/", ["upstream.test"], false),
    ]

    func testSecretScopeHostnameMatchesPinnedTable() {
        for (url, hostname) in Self.scopeHostnames {
            XCTAssertEqual(secretScopeHostname(url), hostname, url)
        }
    }

    func testSecretScopeMatchingMatchesPinnedTable() {
        for (url, patterns, allowed) in Self.scopeMatches {
            XCTAssertEqual(
                isAllowedDomain(patterns: patterns, hostname: secretScopeHostname(url)),
                allowed,
                url
            )
        }
    }

    // MARK: - Raw-fetch contract (#3571)

    // Pinned in `packages/shared-ts/tests/cross-impl-vectors.test.ts`
    // ("cross-implementation raw-fetch contract"): what a bridge puts on the
    // wire in raw mode, so `RawFetchProtocol.swift` answers like node-server.

    private static func pairs(_ list: [(String, String)]) -> RawHeaderList {
        list.map { RawHeaderPair($0.0, $0.1) }
    }

    private static let rawFrames: [(RawFetchResponseHead, String)] = [
        (
            RawFetchResponseHead(
                status: 302,
                statusText: "Found",
                headers: pairs([("location", "/next"), ("set-cookie", "a=1; Path=/"), ("set-cookie", "b=2")]),
                url: "https://example.test/start"
            ),
            "000000997b22737461747573223a3330322c2273746174757354657874223a22466f756e64222c226865616465"
                + "7273223a5b5b226c6f636174696f6e222c222f6e657874225d2c5b227365742d636f6f6b6965222c22613d313b"
                + "20506174683d2f225d2c5b227365742d636f6f6b6965222c22623d32225d5d2c2275726c223a2268747470733a"
                + "2f2f6578616d706c652e746573742f7374617274227d"
        ),
        (
            RawFetchResponseHead(
                status: 200,
                statusText: "",
                headers: pairs([
                    ("x-escapes", "q\"b\\s/\u{08}\u{0C}\n\r\t\u{01}\u{1F}\u{7F}"),
                    ("x-unicode", "bücher 😀 \u{2028}"),
                ]),
                url: "https://bücher.example/"
            ),
            "0000009c7b22737461747573223a3230302c2273746174757354657874223a22222c2268656164657273223a5b"
                + "5b22782d65736361706573222c22715c22625c5c732f5c625c665c6e5c725c745c75303030315c75303031667f"
                + "225d2c5b22782d756e69636f6465222c2262c3bc6368657220f09f988020e280a8225d5d2c2275726c223a2268"
                + "747470733a2f2f62c3bc636865722e6578616d706c652f227d"
        ),
    ]

    private struct RawResponseHeadersVector {
        let name: String
        let method: String
        let status: Int
        let headers: [(String, String)]
        let bodyRewritten: Bool
        let expected: [(String, String)]
    }

    private static let rawResponseHeaders: [RawResponseHeadersVector] = [
        .init(
            name: "decoded gzip drops coding, length and hop fields",
            method: "GET",
            status: 200,
            headers: [
                ("content-encoding", "gzip"), ("content-length", "42"), ("connection", "X-Hop, keep-alive"),
                ("x-hop", "local"), ("keep-alive", "timeout=5"), ("etag", "\"v1\""),
            ],
            bodyRewritten: false,
            expected: [("etag", "\"v1\"")]
        ),
        .init(
            name: "HEAD keeps the representation headers",
            method: "HEAD",
            status: 200,
            headers: [("content-encoding", "gzip"), ("content-length", "1234")],
            bodyRewritten: false,
            expected: [("content-encoding", "gzip"), ("content-length", "1234")]
        ),
        .init(
            name: "a coding the float does not undo stays with its length",
            method: "GET",
            status: 200,
            headers: [("Content-Encoding", "br"), ("Content-Length", "6")],
            bodyRewritten: false,
            expected: [("Content-Encoding", "br"), ("Content-Length", "6")]
        ),
        .init(
            name: "identity coding goes, a rewritten body loses its length",
            method: "GET",
            status: 200,
            headers: [("content-encoding", "identity"), ("content-length", "9"), ("content-type", "text/plain")],
            bodyRewritten: true,
            expected: [("content-type", "text/plain")]
        ),
        .init(
            name: "304 keeps everything but hop fields",
            method: "GET",
            status: 304,
            headers: [("content-encoding", "gzip"), ("transfer-encoding", "chunked")],
            bodyRewritten: true,
            expected: [("content-encoding", "gzip")]
        ),
        .init(
            name: "gzip then identity counts as decoded",
            method: "GET",
            status: 200,
            headers: [("content-encoding", "gzip, identity"), ("content-length", "3")],
            bodyRewritten: false,
            expected: []
        ),
    ]

    private static let rawRequestHeadersInput: [(String, String)] = [
        ("User-Agent", "curl/8.22.0"), ("Cookie", "a=1"), ("Accept-Encoding", "zstd"),
        ("Connection", "X-Hop, keep-alive"), ("X-Hop", "drop me"), ("Host", "example.test"),
        ("Content-Length", "3"), ("Expect", "100-continue"), ("TE", "trailers"), ("cookie", "b=2"),
        ("X-Multi", "1"), ("x-multi", "2"),
    ]
    private static let rawRequestHeadersExpected: [(String, String)] = [
        ("user-agent", "curl/8.22.0"), ("cookie", "a=1; b=2"), ("x-multi", "1, 2"),
    ]

    private static let rawRequestHeads: [(String, RawFetchRequestHead?)] = [
        (
            #"{"url":"https://bücher.example/","method":"PROPFIND","headers":[["X-Name","ü"]]}"#,
            RawFetchRequestHead(url: "https://bücher.example/", method: "PROPFIND", headers: pairs([("X-Name", "ü")]))
        ),
        (
            #"{"url":"https://e.test/","method":"GET","headers":[]}"#,
            RawFetchRequestHead(url: "https://e.test/", method: "GET", headers: [])
        ),
        (#"{"url":1,"method":"GET","headers":[]}"#, nil),
        (#"{"url":"https://e.test/","method":"GET /","headers":[]}"#, nil),
        (#"{"url":"https://e.test/","method":"","headers":[]}"#, nil),
        (#"{"url":"https://e.test/","method":"GET","headers":[["a"]]}"#, nil),
        (#"{"url":"https://e.test/","method":"GET","headers":[["a",1]]}"#, nil),
        (#"{"url":"https://e.test/","method":"GET","headers":[["a",true]]}"#, nil),
        (#"{"url":"https://e.test/","method":"GET"}"#, nil),
        ("[]", nil),
        ("not json", nil),
    ]

    private static let rawUploadStreams: [(headers: [(String, String)], bodyLength: Int?, canStream: Bool, streams: Bool)] = [
        ([("Content-Type", "application/octet-stream")], nil, true, true),
        ([], nil, true, true),
        ([("Content-Type", "application/json")], nil, true, false),
        ([("Content-Type", "application/octet-stream"), ("X-Slicc-Hmac-Sign", "TOKEN:x-signature")], nil, true, false),
        ([("Content-Type", "application/octet-stream")], 1024, true, false),
        ([("Content-Type", "application/octet-stream")], 8 * 1024 * 1024, true, true),
        ([("Content-Type", "application/octet-stream")], nil, false, false),
    ]

    func testRawResponseFramesMatchPinnedBytes() {
        for (head, hex) in Self.rawFrames {
            let frame = RawFetchProtocol.encodeResponseFrame(head)
            XCTAssertEqual(frame.map { String(format: "%02x", $0) }.joined(), hex, "\(head.status)")
        }
    }

    func testRawResponseHeadersMatchPinnedTable() {
        for vector in Self.rawResponseHeaders {
            let actual = RawFetchProtocol.responseHeaders(
                method: vector.method,
                status: vector.status,
                headers: Self.pairs(vector.headers),
                bodyRewritten: vector.bodyRewritten,
                decodedCodings: RawFetchProtocol.decodedCodings
            )
            XCTAssertEqual(actual, Self.pairs(vector.expected), vector.name)
        }
    }

    func testRawRequestHeadersStripAndFoldLikeTypeScript() {
        let folded = RawFetchProtocol.foldRequestHeaders(
            RawFetchProtocol.stripRequestHeaders(Self.pairs(Self.rawRequestHeadersInput))
        )
        XCTAssertEqual(folded, Self.pairs(Self.rawRequestHeadersExpected))
    }

    func testRawRequestHeadsDecodeLikeTypeScript() {
        for (value, head) in Self.rawRequestHeads {
            XCTAssertEqual(RawFetchProtocol.decodeRequestHead(value), head, value)
        }
    }

    func testRawUploadStreamDecisionsMatchPinnedTable() {
        for vector in Self.rawUploadStreams {
            XCTAssertEqual(
                RawFetchProtocol.uploadStreams(
                    headers: Self.pairs(vector.headers),
                    bodyLength: vector.bodyLength,
                    canStream: vector.canStream
                ),
                vector.streams,
                "\(vector.headers) \(String(describing: vector.bodyLength))"
            )
        }
    }
}
