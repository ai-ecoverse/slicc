import Foundation

/// Swift twin of `isTextContentType` in `packages/shared-ts/src/content-type.ts`.
///
/// Answers "is this body safe to decode as UTF-8 text", which on `/api/fetch-proxy`
/// is the same question as "must this body be secret-scrubbed". Node drives its
/// response hop straight off the shared-ts predicate; keeping this list identical
/// is what stops an `application/xml` / `application/javascript` / `image/svg+xml`
/// reply from carrying a real secret back to the agent on Sliccstart while the
/// Node CLI scrubs it (#2822).
///
/// Two deliberate omissions relative to the pre-#2822 local classifier:
///
/// - No `charset=` catch-all. `charset` is a parameter an upstream is free to
///   attach to a binary type (`application/octet-stream; charset=utf-8`), and
///   matching it forces those bytes through a `String` round-trip that Node
///   never performs.
/// - No `event-stream` special case. `text/event-stream` is already covered by
///   the `text/` prefix, which is how Node matches it too.
///
/// The classification table is pinned on both sides by
/// `Tests/CrossImplementationTests.swift` and
/// `packages/shared-ts/tests/content-type-parity.test.ts`.
func isTextContentType(_ contentType: String) -> Bool {
    if contentType.isEmpty { return false }
    let normalized = contentType.lowercased()
    return normalized.hasPrefix("text/")
        || normalized.contains("json")
        || normalized.contains("xml")
        || normalized.contains("javascript")
        || normalized.contains("ecmascript")
        || normalized.contains("html")
        || normalized.contains("css")
        || normalized.contains("svg")
}

/// Request-side variant of `isTextContentType`, additionally matching
/// `application/x-www-form-urlencoded`.
///
/// Mirrors `isTextRequestContentType` in `packages/shared-ts/src/content-type.ts`
/// and gates the fetch-proxy REQUEST-body unmask, where the base predicate gates
/// the response scrub. Form bodies are text here because they carry secrets:
/// OAuth token exchange and a long tail of provider APIs POST
/// `client_secret=…` / `token=…` as a form, and a masked token forwarded
/// verbatim is a silent auth failure upstream (#2821). `urlencoded` stays OUT of
/// the base predicate — on the response hop a form body is rare and the extra
/// match buys nothing.
///
/// An EMPTY content type is deliberately not text: an unlabeled body is as
/// likely to be a JPEG as a form, and the caller's fallback
/// (`SecretInjector.unmaskBodyBytes`) unmasks it byte-safely anyway.
///
/// The request-side table is pinned on both sides by
/// `Tests/CrossImplementationTests.swift` and
/// `packages/shared-ts/tests/cross-impl-vectors.test.ts`.
func isTextRequestContentType(_ contentType: String) -> Bool {
    if contentType.isEmpty { return false }
    return isTextContentType(contentType) || contentType.lowercased().contains("urlencoded")
}
