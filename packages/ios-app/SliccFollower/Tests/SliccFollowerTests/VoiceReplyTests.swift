import XCTest

@testable import SliccFollower

/// The dictation markers and the spoken-reply loop. Both are ports of
/// `packages/webapp/src/speech/{dictation-priming,voice-reply}.ts`, so the
/// cases mirror the web's contract: markers reach the model but never the
/// bubble, and only dictated turns get read back.
@MainActor
final class VoiceReplyTests: XCTestCase {

    /// Records what would have been spoken.
    private final class FakeSpeaker: SpeechSpeaking {
        var spoken: [(text: String, lang: String?)] = []
        var stops = 0
        var availableLanguages: Set<String> = ["en", "de"]

        func speak(_ text: String, lang: String?) { spoken.append((text, lang)) }
        func stop() { stops += 1 }
        func hasVoice(for lang: String) -> Bool {
            availableLanguages.contains(lang.split(separator: "-").first.map(String.init) ?? lang)
        }
    }

    override func setUp() {
        super.setUp()
        DictationPriming.reset()
    }

    // MARK: - Dictation markers

    func testFirstDictatedTurnCarriesThePrimingNote() {
        let marked = DictationPriming.applyMarkers("hello there", isFirst: true)
        XCTAssertTrue(marked.hasPrefix("hello there "))
        XCTAssertTrue(marked.contains(DictationPriming.micGlyph))
        XCTAssertTrue(marked.contains(DictationPriming.primingNote))
    }

    func testLaterDictatedTurnsCarryOnlyTheMicrophone() {
        let marked = DictationPriming.applyMarkers("again", isFirst: false)
        XCTAssertTrue(marked.contains(DictationPriming.micGlyph))
        XCTAssertFalse(marked.contains(DictationPriming.primingNote))
    }

    func testMarkersAreNotDoubleSpaced() {
        XCTAssertEqual(
            DictationPriming.applyMarkers("trailing ", isFirst: false),
            "trailing \(DictationPriming.micGlyph)")
    }

    func testStripMarkersRestoresWhatTheUserSaid() {
        let marked = DictationPriming.applyMarkers("what is the weather", isFirst: true)
        XCTAssertEqual(DictationPriming.stripMarkers(marked), "what is the weather")
    }

    func testStripMarkersHandlesAMessageThatIsOnlyMarkers() {
        let marked = DictationPriming.applyMarkers("", isFirst: true)
        XCTAssertEqual(DictationPriming.stripMarkers(marked), "")
    }

    func testStripMarkersLeavesTypedTextUntouched() {
        let typed = "a normal message with ◁ nothing to strip"
        XCTAssertEqual(DictationPriming.stripMarkers(typed), typed)
    }

    func testFirstFlagIsOneShotUntilReset() {
        XCTAssertTrue(DictationPriming.consumeFirst())
        XCTAssertFalse(DictationPriming.consumeFirst())
        DictationPriming.reset()
        XCTAssertTrue(DictationPriming.consumeFirst(), "a fresh session re-arms the note")
    }

    // MARK: - Reply language marker

    func testReplyLangIsParsedAndStripped() {
        let reply = "<!--lang:de-->Guten Tag."
        XCTAssertEqual(DictationPriming.replyLang(reply), "de")
        XCTAssertEqual(DictationPriming.stripReplyLangMarker(reply), "Guten Tag.")
    }

    func testReplyLangToleratesWhitespaceRegionsAndCasing() {
        XCTAssertEqual(DictationPriming.replyLang("<!-- LANG: pt-BR -->oi"), "pt-BR")
    }

    func testReplyWithoutAMarkerHasNoLanguage() {
        XCTAssertNil(DictationPriming.replyLang("just prose"))
    }

    // MARK: - Markdown to speech

    func testFencedCodeIsNotReadAloud() {
        let text = VoiceReply.speechText(
            fromMarkdown: "Here you go:\n\n```sh\nrm -rf /\n```\n\nDone.")
        XCTAssertFalse(text.contains("rm -rf"))
        XCTAssertTrue(text.contains("Here you go"))
        XCTAssertTrue(text.contains("Done"))
    }

    func testUnterminatedFenceDoesNotLeakItsBody() {
        // A truncated reply would otherwise monologue its whole code block.
        let text = VoiceReply.speechText(fromMarkdown: "Sure:\n\n```js\nconst x = 1;\nconst y")
        XCTAssertEqual(text, "Sure:")
    }

    func testLinksAreSpokenAsTheirLabel() {
        XCTAssertEqual(
            VoiceReply.speechText(fromMarkdown: "See [the docs](https://example.com/a/b)."),
            "See the docs.")
    }

    func testImagesAreSpokenAsTheirAltText() {
        XCTAssertEqual(
            VoiceReply.speechText(fromMarkdown: "![a red cone](x.png)"), "a red cone")
    }

    func testShortInlineCodeIsSpokenAndLongSpansAreDropped() {
        XCTAssertEqual(VoiceReply.speechText(fromMarkdown: "Run `ls` now."), "Run ls now.")
        let long = String(repeating: "x", count: VoiceReply.maxSpokenInlineCodeCharacters + 1)
        XCTAssertEqual(VoiceReply.speechText(fromMarkdown: "Try `\(long)` ok"), "Try ok")
    }

    func testStructuralMarkupIsRemoved() {
        let markdown = """
            # Heading

            > quoted

            - one
            - two

            **bold** and *italic*
            """
        let text = VoiceReply.speechText(fromMarkdown: markdown)
        XCTAssertEqual(text, "Heading quoted one two bold and italic")
    }

    func testRunawayProseIsCappedOnAWordBoundary() {
        let markdown = String(repeating: "word ", count: VoiceReply.maxSpeechCharacters)
        let text = VoiceReply.speechText(fromMarkdown: markdown)
        XCTAssertLessThanOrEqual(text.count, VoiceReply.maxSpeechCharacters + 1)
        XCTAssertTrue(text.hasSuffix("…"))
        XCTAssertFalse(text.hasSuffix("wor…"), "the cap must not split a word")
    }

    // MARK: - The loop

    func testOnlyDictatedTurnsAreSpoken() {
        let speaker = FakeSpeaker()
        let reply = VoiceReply(speaker: speaker)

        XCTAssertFalse(reply.consumeSubmission(), "a typed turn is never voice-initiated")
        reply.markSubmission()
        XCTAssertTrue(reply.consumeSubmission())
        XCTAssertFalse(reply.consumeSubmission(), "one mark answers exactly one turn")
    }

    func testQueuedDictatedTurnsStayBalanced() {
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.markSubmission()
        reply.markSubmission()
        XCTAssertTrue(reply.consumeSubmission())
        XCTAssertTrue(reply.consumeSubmission())
        XCTAssertFalse(reply.consumeSubmission())
    }

    func testResetDropsPendingMarksAndSilencesTheEngine() {
        let speaker = FakeSpeaker()
        let reply = VoiceReply(speaker: speaker)
        reply.markSubmission()
        reply.reset()
        XCTAssertFalse(
            reply.consumeSubmission(), "a stale mark must not speak the next session's reply")
        XCTAssertEqual(speaker.stops, 1)
    }

    func testSpokenReplyUsesTheDeclaredLanguage() {
        let speaker = FakeSpeaker()
        VoiceReply(speaker: speaker).speakReply(markdown: "<!--lang:de-->Guten **Tag**.")
        XCTAssertEqual(speaker.spoken.count, 1)
        XCTAssertEqual(speaker.spoken.first?.text, "Guten Tag.")
        XCTAssertEqual(speaker.spoken.first?.lang, "de")
    }

    func testReplyStaysSilentWhenNoVoiceExistsForItsLanguage() {
        let speaker = FakeSpeaker()
        speaker.availableLanguages = ["en"]
        VoiceReply(speaker: speaker).speakReply(markdown: "<!--lang:ja-->こんにちは")
        XCTAssertTrue(
            speaker.spoken.isEmpty, "better silent than Japanese read in an English voice")
    }

    func testReplyWithoutALanguageMarkerStillSpeaks() {
        let speaker = FakeSpeaker()
        VoiceReply(speaker: speaker).speakReply(markdown: "All done.")
        XCTAssertEqual(speaker.spoken.first?.text, "All done.")
        XCTAssertNil(speaker.spoken.first?.lang)
    }

    func testAReplyThatReducesToNothingIsNotSpoken() {
        let speaker = FakeSpeaker()
        VoiceReply(speaker: speaker).speakReply(markdown: "```\njust code\n```")
        XCTAssertTrue(speaker.spoken.isEmpty)
    }
}
