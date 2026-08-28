import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

/// The verifying halves of the transcript's short actions, plus the wire that
/// carries an action from a span of text to the shell.
final class TranscriptShortActionTests: XCTestCase {

    // MARK: - Payload identification

    private static let pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAA00lEQVR4nAHIADf/AHlCvfIhBvCEd2Lw88tNdk3HByBRFZoPiQDy"
        + "xtrK40S7MRJF/W+E35rXxbPQdqwOj1MApzVsiJE/IPb3LbAi0k0KltrUPBYXwamOAHgSngMnNxBl0JWGTxWtoLhGwcDrxTSK3AB5"
        + "mt+Em60F1KEKwEQequ60tI76Cx8KvYAA6ZijWrpeoL2HmcE1DUOecYl6p1/eMTSkAKpy4FYorG/minM9EWGhXY6uK7BC15WK7QCx"
        + "1ZTW0RLTT2YC9N5xEOmTrnQikj19FxE6BGFaekpuTQAAAABJRU5ErkJggg=="

    func testIdentifiesPNGFromMagicBytes() {
        guard let payload = Base64Payload.identify(Self.pngBase64) else {
            return XCTFail("PNG did not identify")
        }
        XCTAssertEqual(payload.mime, "image/png")
        XCTAssertEqual(payload.source, .magic)
        XCTAssertFalse(payload.text)
        XCTAssertEqual(payload.name, "payload.png")
    }

    /// Magic beats the declaration. A `data:` URL is the author's claim about
    /// their own payload — good evidence, not proof.
    func testMagicOutranksDeclaredType() {
        let payload = Base64Payload.identify(Self.pngBase64, declaredMime: "application/pdf")
        XCTAssertEqual(payload?.mime, "image/png")
    }

    func testDeclaredTypeUsedWhenNothingIsProven() {
        let data = Data("id,name\n1,lars\n".utf8).base64EncodedString()
        let payload = Base64Payload.identify(data, declaredMime: "text/csv; charset=utf-8")
        XCTAssertEqual(payload?.mime, "text/csv")
        XCTAssertEqual(payload?.source, .declared)
    }

    /// `application/octet-stream` is not a claim, so it never wins.
    func testOctetStreamIsNotADeclaration() {
        let data = Data("plain words here".utf8).base64EncodedString()
        let payload = Base64Payload.identify(data, declaredMime: "application/octet-stream")
        XCTAssertEqual(payload?.mime, "text/plain")
        XCTAssertEqual(payload?.source, .content)
    }

    /// The refusal is the point: eliding a run hides text the user wrote, so
    /// unrecognisable bytes stay exactly as typed.
    func testUnrecognisableBytesAreNotAPayload() {
        let noise = Data((0..<200).map { UInt8(($0 * 37) % 251) })
        XCTAssertNil(Base64Payload.identify(noise.base64EncodedString()))
    }

    func testEmptyPayloadIsRejected() {
        XCTAssertNil(Base64Payload.identify(""))
    }

    /// The `also` clause and the longest-signature-first ordering: a bare
    /// `RIFF` prefix must not claim WEBP when the payload is WAVE.
    func testRIFFContainerResolvesByItsInnerTag() {
        func riff(_ tag: String) -> String {
            var bytes = Array("RIFF".utf8) + [0x24, 0x00, 0x00, 0x00] + Array(tag.utf8)
            bytes += Array(repeating: 0x41, count: 24)
            return Data(bytes).base64EncodedString()
        }
        XCTAssertEqual(Base64Payload.identify(riff("WEBP"))?.mime, "image/webp")
        XCTAssertEqual(Base64Payload.identify(riff("WAVE"))?.mime, "audio/wav")
    }

    /// Ogg is a container: the codec name sits in the first page's segment
    /// table, and it is searched as BYTES because the header around it is
    /// binary.
    func testOggResolvesItsCodecToAudioOrVideo() {
        func ogg(_ codec: String) -> String {
            var bytes = Array("OggS".utf8) + Array(repeating: UInt8(0), count: 24)
            bytes += Array(codec.utf8)
            return Data(bytes).base64EncodedString()
        }
        XCTAssertEqual(Base64Payload.identify(ogg("theora"))?.mime, "video/ogg")
        XCTAssertEqual(Base64Payload.identify(ogg("vorbis"))?.mime, "audio/ogg")
    }

    /// A NUL byte is the single most reliable binary tell, and an opaque
    /// archive must be recognised precisely so it is never read as prose.
    func testBinaryFamiliesAreNeverSniffedAsText() {
        let zip = Data([0x50, 0x4B, 0x03, 0x04] + Array(repeating: UInt8(0x41), count: 128))
        XCTAssertEqual(Base64Payload.identify(zip.base64EncodedString())?.mime, "application/zip")
        XCTAssertFalse(MagicBytes.looksLikeText(Data([0x41, 0x00, 0x42])))
        XCTAssertTrue(MagicBytes.looksLikeText(Data()))
    }

    /// A multi-byte sequence cut in half by the sniff window is an artifact of
    /// where we stopped reading, not a decoding failure.
    func testTruncatedUTF8AtTheWindowEdgeIsStillText() {
        var bytes = Data(repeating: 0x41, count: MagicBytes.textSniffWindow - 1)
        bytes.append(contentsOf: [0xE2, 0x9C, 0x93])  // ✓, straddling the edge
        XCTAssertTrue(MagicBytes.looksLikeText(bytes))
    }

    func testChipLabelIsTheShortType() {
        XCTAssertEqual(Base64Payload.identify(Self.pngBase64)?.shortLabel, "PNG")
    }

    // MARK: - Paragraph plan

    func testParagraphElidesConfirmedPayloadAndTrimsItsWhitespace() {
        let markdown = """
            Here is the icon I generated:

            data:image/png;base64,\(Self.pngBase64)

            And that is all.
            """
        let plan = TranscriptParagraph.build(markdown: markdown, files: [:])
        XCTAssertEqual(plan.segments.count, 3)
        guard case .text(let head) = plan.segments[0],
            case .payload(let payload) = plan.segments[1],
            case .text(let tail) = plan.segments[2]
        else { return XCTFail("unexpected segments: \(plan.segments)") }
        // Trimmed: the blank lines around a lifted blob are exactly the noise
        // the chip exists to remove.
        XCTAssertEqual(String(head.characters), "Here is the icon I generated:")
        XCTAssertEqual(String(tail.characters), "And that is all.")
        XCTAssertEqual(payload.mime, "image/png")
    }

    func testParagraphWithoutPayloadIsASingleTextSegment() {
        let plan = TranscriptParagraph.build(markdown: "Just some **prose**.", files: [:])
        XCTAssertEqual(plan.segments.count, 1)
        guard case .text = plan.segments[0] else { return XCTFail("expected a text segment") }
    }

    // MARK: - Annotation

    private func links(_ attributed: AttributedString) -> [TranscriptLink] {
        attributed.runs.compactMap { $0.link.flatMap(TranscriptLink.decode) }
    }

    func testInlineCodeBecomesACodeAction() {
        let annotated = TranscriptInline.annotate(TranscriptInline.parse("run `npm test` now"))
        XCTAssertEqual(links(annotated), [.code("npm test")])
    }

    func testPhoneNumberBecomesAPhoneAction() {
        let annotated = TranscriptInline.annotate(TranscriptInline.parse("call +1 (415) 555-0134"))
        XCTAssertEqual(links(annotated), [.phone("+1 (415) 555-0134")])
    }

    func testUnresolvedFileMentionStaysPlainText() {
        let annotated = TranscriptInline.annotate(TranscriptInline.parse("edit notes.md today"))
        XCTAssertTrue(links(annotated).isEmpty)
    }

    func testResolvedFileMentionBecomesAFileAction() {
        let annotated = TranscriptInline.annotate(
            TranscriptInline.parse("edit notes.md:12 today"),
            files: ["notes.md": "/workspace/notes.md"])
        XCTAssertEqual(links(annotated), [.file(path: "/workspace/notes.md", line: 12)])
    }

    /// A markdown link's own label is the author's choice of destination; a
    /// second link layered over it would silently win.
    func testExistingMarkdownLinkIsNotOverwritten() {
        let annotated = TranscriptInline.annotate(
            TranscriptInline.parse("see [main.ts](https://example.com/x) here"),
            files: ["main.ts": "/workspace/main.ts"])
        let destinations = annotated.runs.compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(destinations, ["https://example.com/x"])
    }

    /// The scan runs on RENDERED characters, so an emoji earlier in the
    /// sentence must not shift the span that gets the link.
    func testAnnotationSurvivesMultiByteCharacters() {
        let annotated = TranscriptInline.annotate(
            TranscriptInline.parse("🍦🍨 shipped — call +1 (415) 555-0134"))
        XCTAssertEqual(links(annotated), [.phone("+1 (415) 555-0134")])
        let linked = annotated.runs.first { $0.link != nil }
        XCTAssertEqual(
            linked.map { String(annotated[$0.range].characters) }, "+1 (415) 555-0134")
    }

    /// A backticked run longer than the cap has nowhere to put its text in a
    /// URL, so it stays inert rather than building a multi-kilobyte link per
    /// render.
    func testOversizeInlineCodeIsNotLinked() {
        let huge = String(repeating: "x", count: TranscriptLink.maximumCodeLength + 1)
        let annotated = TranscriptInline.annotate(TranscriptInline.parse("`\(huge)`"))
        XCTAssertTrue(links(annotated).isEmpty)
    }

    // MARK: - Link round trip

    func testLinkRoundTrip() {
        let cases: [TranscriptLink] = [
            .file(path: "/workspace/a b/notes.md", line: 12),
            .file(path: "/workspace/notes.md", line: nil),
            .phone("+1 (415) 555-0134"),
            .code("echo \"hi & bye\" | grep ?"),
            // The characters a URL would otherwise eat: `#` opens a fragment,
            // `%` opens an escape, `+` is a space in form encoding.
            .code("git log --grep='#42' -- 'a b/c%d+e'"),
            .code("printf '🍦 100%% done\\n'"),
        ]
        for link in cases {
            guard let url = link.url else { return XCTFail("no URL for \(link)") }
            XCTAssertEqual(TranscriptLink.decode(url), link)
        }
    }

    func testForeignURLsAreNotTranscriptLinks() {
        for raw in ["https://example.com", "mailto:a@b.c", "tel:+15551234567", "slicc://open"] {
            XCTAssertNil(TranscriptLink.decode(URL(string: raw)!), raw)
        }
    }

    /// Messages, not the dialer: a transcript number is far more often
    /// something to text a link to than something to ring.
    func testPhoneDefaultsToMessages() {
        XCTAssertEqual(
            TranscriptLink.phone("+1 (415) 555-0134").systemURL?.absoluteString,
            "sms:+14155550134")
    }

    // MARK: - Tool-call path hints

    func testHarvestsQualifiedPathsFromToolInput() {
        let input = AnyCodable([
            "command": "echo hi > /home/lars/foo.md",
            "cwd": "/workspace",
        ])
        XCTAssertEqual(ToolCallPathHints.hints(from: input), ["/home/lars/foo.md"])
    }

    func testHarvestsThroughOneNestedContainer() {
        let input = AnyCodable(["files": ["/workspace/docs/plan.md", "/workspace/docs/rfc.md"]])
        XCTAssertEqual(
            ToolCallPathHints.hints(from: input),
            ["/workspace/docs/plan.md", "/workspace/docs/rfc.md"])
    }

    /// Two containers deep is the floor, mirroring the web's `collectStrings`.
    /// Parameters live at the top level or one container down; descending
    /// further means walking arbitrary tool payloads for diminishing returns,
    /// and the follower pays a `stat` for every hint it keeps.
    func testStopsAtTwoContainersDeep() {
        let input = AnyCodable(["edits": [["path": "/workspace/docs/plan.md"]]])
        XCTAssertEqual(ToolCallPathHints.hints(from: input), [])
    }

    /// A bare basename adds nothing the leader could not already find, and a
    /// URL's path is not a file on the leader at all.
    func testDropsBareNamesAndURLs() {
        let input = AnyCodable(["note": "read foo.md", "docs": "https://example.com/app.js"])
        XCTAssertEqual(ToolCallPathHints.hints(from: input), [])
    }

    // MARK: - Resolver

    private func resolver(
        _ probe: @escaping @Sendable (String) async -> Bool
    ) -> FileMentionResolver {
        FileMentionResolver(probe: probe)
    }

    func testAbsolutePathResolvesWithOneStat() async {
        let asked = Counter()
        let resolver = resolver { path in
            await asked.record(path)
            return path == "/workspace/notes.md"
        }
        let hit = await resolver.resolve("/workspace/notes.md")
        XCTAssertEqual(hit, "/workspace/notes.md")
        let miss = await resolver.resolve("/workspace/missing.md")
        XCTAssertNil(miss)
        let seen = await asked.values
        XCTAssertEqual(seen, ["/workspace/notes.md", "/workspace/missing.md"])
    }

    /// The follower has no VFS to walk, so a bare name resolves only through a
    /// path the turn's own tool calls already named.
    func testBareNameResolvesThroughAToolCallHint() async {
        let resolver = resolver { $0 == "/home/lars/foo.md" }
        resolver.absorb(toolInput: AnyCodable(["command": "echo hi > /home/lars/foo.md"]))
        let resolved = await resolver.resolve("foo.md")
        XCTAssertEqual(resolved, "/home/lars/foo.md")
    }

    func testBareNameWithoutAHintStaysUnresolved() async {
        let resolver = resolver { _ in true }
        let resolved = await resolver.resolve("foo.md")
        XCTAssertNil(resolved)
    }

    /// Suffix matching at a segment boundary: `webapp/src/main.ts` means
    /// `/packages/webapp/src/main.ts`, never `/other/xwebapp/src/main.ts`.
    func testSuffixMatchRespectsSegmentBoundaries() {
        XCTAssertTrue(
            FileMentionResolver.matchesSuffix("/packages/webapp/src/main.ts", "webapp/src/main.ts"))
        XCTAssertFalse(
            FileMentionResolver.matchesSuffix("/other/xwebapp/src/main.ts", "webapp/src/main.ts"))
    }

    func testNormalizeStripsRelativePrefixes() {
        XCTAssertEqual(FileMentionResolver.normalize("./foo/bar.ts"), "foo/bar.ts")
        XCTAssertEqual(FileMentionResolver.normalize("../../foo.ts"), "foo.ts")
        XCTAssertEqual(FileMentionResolver.normalize("~/.config/app.toml"), ".config/app.toml")
    }

    /// A "no" is cached too — it is the common case, and re-asking on every
    /// streaming chunk would put a round trip per token on the wire.
    func testVerdictsAreCachedIncludingMisses() async {
        let asked = Counter()
        let resolver = resolver { path in
            await asked.record(path)
            return false
        }
        _ = await resolver.resolve("/workspace/a.md")
        _ = await resolver.resolve("/workspace/a.md")
        let count = await asked.values.count
        XCTAssertEqual(count, 1)
    }

    /// A different leader has a different filesystem.
    func testResetDropsHintsAndVerdicts() async {
        let resolver = resolver { $0 == "/home/lars/foo.md" }
        resolver.absorb(toolInput: AnyCodable(["command": "cat /home/lars/foo.md"]))
        XCTAssertEqual(resolver.hints, ["/home/lars/foo.md"])
        resolver.reset()
        XCTAssertTrue(resolver.hints.isEmpty)
        let resolved = await resolver.resolve("foo.md")
        XCTAssertNil(resolved)
    }

    func testExpiredVerdictIsAskedAgain() async {
        let asked = Counter()
        let clock = Clock()
        let resolver = FileMentionResolver(
            ttl: 30, now: { clock.now },
            probe: { path in
                await asked.record(path)
                return true
            })
        _ = await resolver.resolve("/workspace/a.md")
        clock.advance(31)
        _ = await resolver.resolve("/workspace/a.md")
        let count = await asked.values.count
        XCTAssertEqual(count, 2)
    }

    // MARK: - Cache

    func testInlineCacheReturnsTheSamePlanForTheSameInput() {
        let markdown = "run `npm test` in packages/webapp/src/main.ts"
        let first = TranscriptInlineCache.shared.paragraph(markdown: markdown, files: [:])
        let second = TranscriptInlineCache.shared.paragraph(markdown: markdown, files: [:])
        XCTAssertEqual(String(first.attributed.characters), String(second.attributed.characters))
    }

    /// The confirmed-file map is part of the key, so a mention that resolves
    /// after the first paint rebuilds the run instead of serving the inert one.
    func testResolvingAMentionChangesTheCacheKey() {
        let markdown = "open notes.md"
        let inert = TranscriptInlineCache.shared.paragraph(markdown: markdown, files: [:])
        let linked = TranscriptInlineCache.shared.paragraph(
            markdown: markdown, files: ["notes.md": "/workspace/notes.md"])
        XCTAssertNil(inert.attributed.runs.first { $0.link != nil })
        XCTAssertNotNil(linked.attributed.runs.first { $0.link != nil })
        XCTAssertNotEqual(
            TranscriptInlineCache.cacheKey(markdown: markdown, files: [:]),
            TranscriptInlineCache.cacheKey(
                markdown: markdown, files: ["notes.md": "/workspace/notes.md"]))
    }

    // MARK: - Leader probe

    /// A disconnected follower answers "no" rather than queueing: `FsClient`
    /// would hold the request until its 30-second timeout, and a mention that
    /// links a reconnect later is worse than one that never links at all.
    @MainActor
    func testDisconnectedFollowerNeverConfirmsAMention() async {
        let appState = AppState()
        let exists = await appState.transcriptFileExists("/workspace/notes.md")
        XCTAssertFalse(exists)
    }

    /// Connected but with nowhere to send: the request fails and the mention
    /// stays plain text rather than throwing out of the render path.
    @MainActor
    func testProbeSwallowsALeaderFailure() async {
        let appState = AppState()
        appState.connectionState = .connected
        let exists = await appState.transcriptFileExists("/workspace/notes.md")
        XCTAssertFalse(exists)
    }

    // MARK: - Helpers

    private actor Counter {
        private(set) var values: [String] = []
        func record(_ value: String) { values.append(value) }
    }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var offset: TimeInterval = 0
        private let base = Date(timeIntervalSince1970: 1_700_000_000)
        var now: Date {
            lock.lock()
            defer { lock.unlock() }
            return base.addingTimeInterval(offset)
        }
        func advance(_ seconds: TimeInterval) {
            lock.lock()
            offset += seconds
            lock.unlock()
        }
    }
}
