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
        XCTAssertTrue(DictationPriming.isFirstPending)
        DictationPriming.commitFirst()
        XCTAssertFalse(DictationPriming.isFirstPending)
        DictationPriming.reset()
        XCTAssertTrue(DictationPriming.isFirstPending, "a fresh session re-arms the note")
    }

    func testPeekingTheFirstFlagDoesNotSpendIt() {
        // A dictated send builds its marked text before it knows the send
        // succeeded; only a delivered message may spend the priming note.
        XCTAssertTrue(DictationPriming.isFirstPending)
        XCTAssertTrue(DictationPriming.isFirstPending)
        DictationPriming.commitFirst()
        XCTAssertFalse(DictationPriming.isFirstPending)
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

    // MARK: - Installed voice selection

    private func voice(
        _ identifier: String,
        _ language: String,
        _ quality: AVSpeechSpeaker.VoiceCandidate.Quality
    ) -> AVSpeechSpeaker.VoiceCandidate {
        .init(identifier: identifier, language: language, quality: quality)
    }

    func testInstalledVoiceQualityRanksPremiumThenEnhancedThenDefault() {
        let voices = [
            voice("compact", "en-US", .default),
            voice("premium", "en-US", .premium),
            voice("enhanced", "en-US", .enhanced),
        ]

        XCTAssertEqual(
            AVSpeechSpeaker.rankedVoice(for: "en-US", from: voices)?.identifier,
            "premium")
    }

    func testExactLanguageMatchPrecedesHigherQualityBaseMatch() {
        let voices = [
            voice("british-premium", "en-GB", .premium),
            voice("american-compact", "en-US", .default),
        ]

        XCTAssertEqual(
            AVSpeechSpeaker.rankedVoice(for: "en-US", from: voices)?.identifier,
            "american-compact")
    }

    func testBaseLanguageFallbackStillRanksQuality() {
        let voices = [
            voice("german-enhanced", "de-DE", .enhanced),
            voice("austrian-premium", "de-AT", .premium),
        ]

        XCTAssertEqual(
            AVSpeechSpeaker.rankedVoice(for: "de", from: voices)?.identifier,
            "austrian-premium")
    }

    func testVoiceIdentifierBreaksOtherwiseEqualTies() {
        let voices = [
            voice("zeta", "fr-FR", .premium),
            voice("alpha", "fr-FR", .premium),
        ]

        XCTAssertEqual(
            AVSpeechSpeaker.rankedVoice(for: "fr-FR", from: voices)?.identifier,
            "alpha")
    }

    func testUnavailableLanguageHasNoRankedVoice() {
        let voices = [voice("english", "en-US", .premium)]
        XCTAssertNil(AVSpeechSpeaker.rankedVoice(for: "ja", from: voices))
    }

    // MARK: - The loop

    /// Mark, bind and consume in the order the transport delivers them.
    private func answer(
        _ reply: VoiceReply, scoop: String, messageId: String
    ) -> Bool {
        reply.bindReply(scoopJid: scoop, messageId: messageId)
        return reply.consumeSubmission(scoopJid: scoop, messageId: messageId)
    }

    func testOnlyDictatedTurnsAreSpoken() {
        let reply = VoiceReply(speaker: FakeSpeaker())

        XCTAssertFalse(
            answer(reply, scoop: "cone", messageId: "m1"),
            "a typed turn is never voice-initiated")
        reply.markSubmission(scoopJid: "cone")
        XCTAssertTrue(answer(reply, scoop: "cone", messageId: "m2"))
        XCTAssertFalse(
            answer(reply, scoop: "cone", messageId: "m3"),
            "one mark answers exactly one turn")
    }

    func testQueuedDictatedTurnsStayBalanced() {
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.markSubmission(scoopJid: "cone")
        reply.markSubmission(scoopJid: "cone")
        XCTAssertTrue(answer(reply, scoop: "cone", messageId: "m1"))
        XCTAssertTrue(answer(reply, scoop: "cone", messageId: "m2"))
        XCTAssertFalse(answer(reply, scoop: "cone", messageId: "m3"))
    }

    func testAReplyAlreadyStreamingCannotClaimALaterMark() {
        // The typed turn opened its message BEFORE the user dictated, so its
        // completion must not consume the dictated mark and read the wrong
        // answer aloud while the dictated one stays silent.
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.bindReply(scoopJid: "cone", messageId: "typed")
        reply.markSubmission(scoopJid: "cone")

        XCTAssertFalse(
            reply.consumeSubmission(scoopJid: "cone", messageId: "typed"),
            "the in-flight typed reply predates the mark")
        XCTAssertTrue(
            answer(reply, scoop: "cone", messageId: "dictated"),
            "the next message the scoop opens is the dictated answer")
    }

    func testAnotherScoopFinishingFirstDoesNotStealTheMark() {
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.markSubmission(scoopJid: "cone")

        XCTAssertFalse(
            answer(reply, scoop: "scoop-a", messageId: "m1"),
            "a concurrent scoop's reply answers nothing the user dictated")
        XCTAssertTrue(answer(reply, scoop: "cone", messageId: "m2"))
    }

    func testRollbackRetiresAMarkWhoseSendNeverLeft() {
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.markSubmission(scoopJid: "cone")
        reply.rollbackSubmission(scoopJid: "cone")
        XCTAssertFalse(
            answer(reply, scoop: "cone", messageId: "m1"),
            "an undelivered message will never be answered")
    }

    func testRollbackLeavesAnAlreadyBoundMarkAlone() {
        // A failed send must retire ITS mark, not one already matched to a
        // reply that is on its way.
        let reply = VoiceReply(speaker: FakeSpeaker())
        reply.markSubmission(scoopJid: "cone")
        reply.bindReply(scoopJid: "cone", messageId: "inflight")
        reply.rollbackSubmission(scoopJid: "cone")
        XCTAssertTrue(reply.consumeSubmission(scoopJid: "cone", messageId: "inflight"))
    }

    func testResetDropsPendingMarksAndSilencesTheEngine() {
        let speaker = FakeSpeaker()
        let reply = VoiceReply(speaker: speaker)
        reply.markSubmission(scoopJid: "cone")
        reply.reset()
        XCTAssertFalse(
            answer(reply, scoop: "cone", messageId: "m1"),
            "a stale mark must not speak the next session's reply")
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
