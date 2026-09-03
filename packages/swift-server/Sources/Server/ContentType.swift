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
