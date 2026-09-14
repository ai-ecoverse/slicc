import XCTest

@testable import SliccFollower
@testable import SliccTrayKit



final class TranscriptShortActionTests: XCTestCase {

    

    private static let pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAB9UlEQVR42u3dMQ2AMABE0fqoAwZWtGACb11QUBO1gQIMwNrk0pd8"
        + "ATe8/cp1jrj2fsf1tCOuWre4CtBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMN9OKgE3FIfwEtoCWgJaAloAW0BLQEtAS0BLSAloCWgJaAloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAlo"
        + "CWgBLQEtAS0BrdVBO96ck+NNT7JAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNAzQCeOloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAloAS0BLQEtAS0BLaAloCWgJaAloAW0BLQEtAS0"
        + "BLSAloCWgJaAlj57AcfNe/5HMj6nAAAAAElFTkSuQmCC"

    func testIdentifiesPNGFromMagicBytes() {
        guard let payload = Base64Payload.identify(Self.pngBase64) else {
            return XCTFail("PNG did not identify")
        }
        XCTAssertEqual(payload.mime, "image/png")
        XCTAssertEqual(payload.source, .magic)
        XCTAssertFalse(payload.text)
        XCTAssertEqual(payload.name, "payload.png")
    }

    
    
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

    
    func testOctetStreamIsNotADeclaration() {
        let data = Data("plain words here".utf8).base64EncodedString()
        let payload = Base64Payload.identify(data, declaredMime: "application/octet-stream")
        XCTAssertEqual(payload?.mime, "text/plain")
        XCTAssertEqual(payload?.source, .content)
    }

    
    
    func testUnrecognisableBytesAreNotAPayload() {
        let noise = Data((0..<200).map { UInt8(($0 * 37) % 251) })
        XCTAssertNil(Base64Payload.identify(noise.base64EncodedString()))
    }

    func testEmptyPayloadIsRejected() {
        XCTAssertNil(Base64Payload.identify(""))
    }

    
    
    func testRIFFContainerResolvesByItsInnerTag() {
        func riff(_ tag: String) -> String {
            var bytes = Array("RIFF".utf8) + [0x24, 0x00, 0x00, 0x00] + Array(tag.utf8)
            bytes += Array(repeating: 0x41, count: 24)
            return Data(bytes).base64EncodedString()
        }
        XCTAssertEqual(Base64Payload.identify(riff("WEBP"))?.mime, "image/webp")
        XCTAssertEqual(Base64Payload.identify(riff("WAVE"))?.mime, "audio/wav")
    }

    
    
    
    func testOggResolvesItsCodecToAudioOrVideo() {
        func ogg(_ codec: String) -> String {
            var bytes = Array("OggS".utf8) + Array(repeating: UInt8(0), count: 24)
            bytes += Array(codec.utf8)
            return Data(bytes).base64EncodedString()
        }
        XCTAssertEqual(Base64Payload.identify(ogg("theora"))?.mime, "video/ogg")
        XCTAssertEqual(Base64Payload.identify(ogg("vorbis"))?.mime, "audio/ogg")
    }

    
    
    func testBinaryFamiliesAreNeverSniffedAsText() {
        let zip = Data([0x50, 0x4B, 0x03, 0x04] + Array(repeating: UInt8(0x41), count: 128))
        XCTAssertEqual(Base64Payload.identify(zip.base64EncodedString())?.mime, "application/zip")
        XCTAssertFalse(MagicBytes.looksLikeText(Data([0x41, 0x00, 0x42])))
        XCTAssertTrue(MagicBytes.looksLikeText(Data()))
    }

    
    
    func testTruncatedUTF8AtTheWindowEdgeIsStillText() {
        var bytes = Data(repeating: 0x41, count: MagicBytes.textSniffWindow - 1)
        bytes.append(contentsOf: [0xE2, 0x9C, 0x93])  
        XCTAssertTrue(MagicBytes.looksLikeText(bytes))
    }

    func testChipLabelIsTheShortType() {
        XCTAssertEqual(Base64Payload.identify(Self.pngBase64)?.shortLabel, "PNG")
    }

    

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
        
        
        XCTAssertEqual(String(head.characters), "Here is the icon I generated:")
        XCTAssertEqual(String(tail.characters), "And that is all.")
        XCTAssertEqual(payload.mime, "image/png")
    }

    func testParagraphWithoutPayloadIsASingleTextSegment() {
        let plan = TranscriptParagraph.build(markdown: "Just some **prose**.", files: [:])
        XCTAssertEqual(plan.segments.count, 1)
        guard case .text = plan.segments[0] else { return XCTFail("expected a text segment") }
    }

    

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

    
    
    func testExistingMarkdownLinkIsNotOverwritten() {
        let annotated = TranscriptInline.annotate(
            TranscriptInline.parse("see [main.ts](https://example.com/x) here"),
            files: ["main.ts": "/workspace/main.ts"])
        let destinations = annotated.runs.compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(destinations, ["https://example.com/x"])
    }

    
    
    func testAnnotationSurvivesMultiByteCharacters() {
        let annotated = TranscriptInline.annotate(
            TranscriptInline.parse("🍦🍨 shipped — call +1 (415) 555-0134"))
        XCTAssertEqual(links(annotated), [.phone("+1 (415) 555-0134")])
        let linked = annotated.runs.first { $0.link != nil }
        XCTAssertEqual(
            linked.map { String(annotated[$0.range].characters) }, "+1 (415) 555-0134")
    }

    
    
    
    func testOversizeInlineCodeIsNotLinked() {
        let huge = String(repeating: "x", count: TranscriptLink.maximumCodeLength + 1)
        let annotated = TranscriptInline.annotate(TranscriptInline.parse("`\(huge)`"))
        XCTAssertTrue(links(annotated).isEmpty)
    }

    

    func testLinkRoundTrip() {
        let cases: [TranscriptLink] = [
            .file(path: "/workspace/a b/notes.md", line: 12),
            .file(path: "/workspace/notes.md", line: nil),
            .phone("+1 (415) 555-0134"),
            .code("echo \"hi & bye\" | grep ?"),
            
            
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

    
    
    func testPhoneDefaultsToMessages() {
        XCTAssertEqual(
            TranscriptLink.phone("+1 (415) 555-0134").systemURL?.absoluteString,
            "sms:+14155550134")
    }

    

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

    
    
    
    
    func testStopsAtTwoContainersDeep() {
        let input = AnyCodable(["edits": [["path": "/workspace/docs/plan.md"]]])
        XCTAssertEqual(ToolCallPathHints.hints(from: input), [])
    }

    
    
    func testDropsBareNamesAndURLs() {
        let input = AnyCodable(["note": "read foo.md", "docs": "https://example.com/app.js"])
        XCTAssertEqual(ToolCallPathHints.hints(from: input), [])
    }

    

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

    

    func testInlineCacheReturnsTheSamePlanForTheSameInput() {
        let markdown = "run `npm test` in packages/webapp/src/main.ts"
        let first = TranscriptInlineCache.shared.paragraph(markdown: markdown, files: [:])
        let second = TranscriptInlineCache.shared.paragraph(markdown: markdown, files: [:])
        XCTAssertEqual(String(first.attributed.characters), String(second.attributed.characters))
    }

    
    
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

    

    
    
    
    @MainActor
    func testDisconnectedFollowerNeverConfirmsAMention() async {
        let appState = AppState()
        let exists = await appState.transcriptFileExists("/workspace/notes.md")
        XCTAssertFalse(exists)
    }

    
    
    @MainActor
    func testProbeSwallowsALeaderFailure() async {
        let appState = AppState()
        appState.connectionState = .connected
        let exists = await appState.transcriptFileExists("/workspace/notes.md")
        XCTAssertFalse(exists)
    }

    

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
