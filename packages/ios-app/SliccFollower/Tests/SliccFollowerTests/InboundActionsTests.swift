import SliccTrayKit
import XCTest

@testable import SliccFollower

/// The inbound-action funnel (#1918): parsing, validation, dedup, and the
/// one-shot waiters. Everything here is untrusted-input handling — the
/// tests bias toward proving rejection paths, not just the happy ones.
final class InboundActionsTests: XCTestCase {

    // MARK: - Deep link parsing

    @MainActor
    func testOpenDeepLinkShortFormEnqueuesConfirmedAction() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(
            coordinator.receive(deepLink: URL(string: "slicc://open?url=https%3A%2F%2Fexample.com%2Fdocs")!))
        XCTAssertEqual(coordinator.pendingOpen?.url.absoluteString, "https://example.com/docs")
        XCTAssertEqual(coordinator.pendingOpen?.needsConfirmation, true)
    }

    @MainActor
    func testPromptXCallbackFormCarriesCallbacks() {
        let coordinator = InboundActionCoordinator()
        let link = "slicc://x-callback-url/prompt?prompt=hello&x-success=shortcuts://done&x-error=shortcuts://err"
        XCTAssertTrue(coordinator.receive(deepLink: URL(string: link)!))
        XCTAssertEqual(coordinator.pendingPrompt?.prompt, "hello")
        XCTAssertEqual(coordinator.pendingPrompt?.xSuccess?.scheme, "shortcuts")
        XCTAssertEqual(coordinator.pendingPrompt?.xError?.scheme, "shortcuts")
        XCTAssertNil(coordinator.pendingPrompt?.xCancel)
        XCTAssertEqual(coordinator.pendingPrompt?.needsConfirmation, true)
    }

    @MainActor
    func testUnknownActionAndForeignSchemeAreRejected() {
        let coordinator = InboundActionCoordinator()
        XCTAssertFalse(coordinator.receive(deepLink: URL(string: "slicc://frobnicate?x=1")!))
        XCTAssertFalse(coordinator.receive(deepLink: URL(string: "https://open?url=https://a.example")!))
        XCTAssertNil(coordinator.pendingOpen)
    }

    // MARK: - URL validation

    @MainActor
    func testCredentialBearingAndNonWebURLsAreRejected() {
        let coordinator = InboundActionCoordinator()
        XCTAssertFalse(
            coordinator.receive(url: URL(string: "https://user:pw@example.com")!, needsConfirmation: true),
            "embedded credentials are refused")
        XCTAssertFalse(
            coordinator.receive(url: URL(string: "ftp://example.com/file")!, needsConfirmation: true),
            "non-http(s) schemes belong to #1917, not this path")
        let oversized = "https://example.com/" + String(repeating: "a", count: 2100)
        XCTAssertFalse(
            coordinator.receive(url: URL(string: oversized)!, needsConfirmation: true),
            "oversized URLs are refused")
        XCTAssertNil(coordinator.pendingOpen)
    }

    @MainActor
    func testCallbackURLsMustBeCustomScheme() {
        XCTAssertNil(InboundActionCoordinator.callbackURL("https://evil.example/cb"))
        XCTAssertNil(InboundActionCoordinator.callbackURL("slicc://open?url=https://loop.example"))
        XCTAssertNotNil(InboundActionCoordinator.callbackURL("shortcuts://x-callback-url/run"))
        XCTAssertNil(InboundActionCoordinator.callbackURL(nil))
    }

    // MARK: - Replay dedup

    @MainActor
    func testReplayedOpenKeepsFirstPendingAction() {
        let coordinator = InboundActionCoordinator()
        let url = URL(string: "https://example.com")!
        XCTAssertTrue(coordinator.receive(url: url, needsConfirmation: true))
        let first = coordinator.pendingOpen?.id
        XCTAssertTrue(coordinator.receive(url: url, needsConfirmation: true), "a retry is accepted…")
        XCTAssertEqual(coordinator.pendingOpen?.id, first, "…but does not mint a new action")
    }

    @MainActor
    func testReplayedPromptKeepsFirstPendingAction() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(coordinator.receive(prompt: "same", xSuccess: nil, xError: nil, xCancel: nil))
        let first = coordinator.pendingPrompt?.id
        XCTAssertTrue(coordinator.receive(prompt: "same", xSuccess: nil, xError: nil, xCancel: nil))
        XCTAssertEqual(coordinator.pendingPrompt?.id, first)
    }

    // MARK: - Universal links

    @MainActor
    func testAppLinkRouteMirrorsSchemeContract() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(
            coordinator.receive(appLink: URL(string: "https://www.sliccy.ai/app/open?url=https%3A%2F%2Fexample.com")!))
        XCTAssertEqual(coordinator.pendingOpen?.url.host(), "example.com")
        XCTAssertFalse(
            coordinator.receive(appLink: URL(string: "https://elsewhere.example/app/open?url=https%3A%2F%2Fexample.com")!),
            "foreign hosts never route")
        XCTAssertFalse(
            coordinator.receive(appLink: URL(string: "https://sliccy.ai/handoff?handoff=x")!),
            "non-/app/ paths never route")
    }

    // MARK: - Prompt waiter

    @MainActor
    func testWaiterSettlesOnceAndIgnoresForeignScoop() {
        let waiter = InboundPromptWaiter()
        var outcomes: [InboundPromptWaiter.Outcome] = []
        let token = waiter.arm(scoopJid: "cone") { outcomes.append($0) }

        waiter.settle(with: "ignored", scoopJid: "other-scoop")
        XCTAssertTrue(outcomes.isEmpty, "a foreign scoop's reply never settles the waiter")

        waiter.settle(with: "the reply", scoopJid: "cone")
        waiter.settle(with: "a second reply", scoopJid: "cone")
        XCTAssertFalse(waiter.timeout(token: token))

        XCTAssertEqual(outcomes.count, 1, "first settle consumes the waiter")
        guard case .reply(let text) = outcomes[0] else { return XCTFail("expected a reply") }
        XCTAssertEqual(text, "the reply")
    }

    @MainActor
    func testWaiterTimeoutSettlesFailure() {
        let waiter = InboundPromptWaiter()
        var outcomes: [InboundPromptWaiter.Outcome] = []
        let token = waiter.arm(scoopJid: "cone") { outcomes.append($0) }
        XCTAssertTrue(waiter.timeout(token: token))
        waiter.settle(with: "late answer", scoopJid: "cone")
        XCTAssertEqual(outcomes.count, 1, "a late answer must not settle a timed-out request")
        guard case .failure = outcomes[0] else { return XCTFail("expected a failure") }
    }

    @MainActor
    func testStaleWaiterTimeoutDoesNotSettleReplacement() {
        let waiter = InboundPromptWaiter()
        var outcomes: [InboundPromptWaiter.Outcome] = []
        let staleToken = waiter.arm(scoopJid: "cone") { outcomes.append($0) }
        let currentToken = waiter.arm(scoopJid: "cone") { outcomes.append($0) }

        XCTAssertFalse(waiter.timeout(token: staleToken))
        XCTAssertTrue(outcomes.isEmpty, "an earlier timeout must not settle the replacement")
        XCTAssertTrue(waiter.timeout(token: currentToken))
        XCTAssertEqual(outcomes.count, 1)
    }

    // MARK: - Snapshot waiter

    @MainActor
    func testStaleSnapshotTimeoutDoesNotDisarmReplacement() {
        let waiter = InboundSnapshotWaiter()
        var settled = false
        let staleToken = waiter.arm(scoopJid: "cone") {}
        let currentToken = waiter.arm(scoopJid: "cone") { settled = true }

        XCTAssertFalse(waiter.timeout(token: staleToken))
        waiter.settle(scoopJid: "cone")
        XCTAssertTrue(settled, "the replacement must remain armed after an earlier timeout")
        XCTAssertFalse(waiter.timeout(token: currentToken))
    }

    // MARK: - App Group inbox

    func testInboxRoundTripsAndCaps() throws {
        let suite = "test-inbox-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let inbox = AppGroupInbox(defaults: defaults)

        for i in 0..<AppGroupInbox.maxPending {
            XCTAssertTrue(inbox.enqueue(url: URL(string: "https://example.com/\(i)")!))
        }
        XCTAssertFalse(
            inbox.enqueue(url: URL(string: "https://example.com/overflow")!),
            "a stuck queue stops accepting rather than growing")

        let drained = inbox.drain()
        XCTAssertEqual(drained.count, AppGroupInbox.maxPending)
        XCTAssertTrue(inbox.drain().isEmpty, "drain is one-time — no replay")
    }

    // MARK: - Transcript rendering

    @MainActor
    func testTranscriptMarkdownRendersRolesAndTruncatesHeadFirst() {
        let filler = String(repeating: "x", count: 64 * 1024)
        var messages: [ChatMessage] = (0..<12).map {
            ChatMessage(id: "old-\($0)", role: .user, content: filler, timestamp: 0)
        }
        messages.append(ChatMessage(id: "final", role: .assistant, content: "the newest reply", timestamp: 1))

        let markdown = ChatView.transcriptMarkdown(label: "Cone", messages: messages)

        XCTAssertLessThanOrEqual(markdown.utf8.count, InboundActionCoordinator.maxTranscriptBytes)
        XCTAssertTrue(markdown.contains("the newest reply"), "newest turns survive truncation")
        XCTAssertTrue(markdown.hasPrefix("_older turns truncated_"), "truncation is declared, not silent")
        XCTAssertTrue(markdown.contains("## Cone"), "assistant sections carry the label")
    }

    // MARK: - Conversation selection (Open Conversation intent)

    @MainActor
    func testSelectionEnqueuesTheJid() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(coordinator.receive(selecting: "scoop-42"))
        XCTAssertEqual(coordinator.pendingSelection?.scoopJid, "scoop-42")
    }

    /// An intent parameter is still input, even when Siri resolved it from
    /// our own entity — the funnel validates it like everything else.
    @MainActor
    func testEmptyAndOversizedJidsAreRejected() {
        let coordinator = InboundActionCoordinator()
        XCTAssertFalse(coordinator.receive(selecting: ""))
        XCTAssertFalse(coordinator.receive(selecting: "   \n "))
        let huge = String(repeating: "j", count: InboundActionCoordinator.maxJidLength + 1)
        XCTAssertFalse(coordinator.receive(selecting: huge))
        XCTAssertNil(coordinator.pendingSelection)
    }

    @MainActor
    func testSelectionIsTrimmed() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(coordinator.receive(selecting: "  scoop-7\n"))
        XCTAssertEqual(coordinator.pendingSelection?.scoopJid, "scoop-7")
    }

    /// The id check keeps a stale card from consuming a newer request —
    /// same rule the open and prompt slots follow.
    @MainActor
    func testConsumingAStaleSelectionLeavesTheNewerOne() {
        let coordinator = InboundActionCoordinator()
        XCTAssertTrue(coordinator.receive(selecting: "first"))
        let stale = coordinator.pendingSelection!
        XCTAssertTrue(coordinator.receive(selecting: "second"))
        coordinator.consume(selection: stale)
        XCTAssertEqual(coordinator.pendingSelection?.scoopJid, "second")
        coordinator.consume(selection: coordinator.pendingSelection!)
        XCTAssertNil(coordinator.pendingSelection)
    }

    // MARK: - Selection resolution against the roster (PR #2582 review, P1)

    private func outcome(
        _ jid: String, roster: [String], age: TimeInterval = 0
    ) -> InboundSelectionRule.Outcome {
        InboundSelectionRule.outcome(forSelecting: jid, roster: roster, age: age)
    }

    /// The regression: a Spotlight/Siri hit opens the app COLD, so the request
    /// lands before the first `scoops.list`. An empty roster is "not told
    /// yet", not "not found" — resolving it as absent dropped the request on
    /// the feature's main path.
    func testEmptyRosterWaitsRatherThanDropping() {
        XCTAssertEqual(outcome("scoop-1", roster: []), .wait)
    }

    func testRosterContainingTheUnitSelectsIt() {
        XCTAssertEqual(outcome("scoop-1", roster: ["other", "scoop-1"]), .select)
    }

    /// A non-empty roster is the leader's full answer, so absence from it is
    /// authoritative — that is the genuinely-ended scoop, where staying put
    /// beats jumping to a dead unit.
    func testNonEmptyRosterWithoutTheUnitDrops() {
        XCTAssertEqual(outcome("gone", roster: ["a", "b"]), .drop)
    }

    /// Without an age bound a request made before any leader was reachable
    /// would fire whenever one eventually connected.
    func testAStaleRequestIsDroppedEvenWithNoRosterYet() {
        let old = InboundSelectionRule.maximumAge + 1
        XCTAssertEqual(outcome("scoop-1", roster: [], age: old), .drop)
    }

    /// Age only decides once the roster cannot: a unit that IS present is
    /// still selected, because the user asked for something that exists.
    func testAgeDoesNotOverrideAPresentUnit() {
        let old = InboundSelectionRule.maximumAge + 1
        XCTAssertEqual(outcome("scoop-1", roster: ["scoop-1"], age: old), .select)
    }

    /// The whole cold-launch sequence, in order.
    func testColdLaunchStaysArmedUntilTheRosterArrives() {
        XCTAssertEqual(outcome("scoop-1", roster: []), .wait)
        XCTAssertEqual(outcome("scoop-1", roster: []), .wait)
        XCTAssertEqual(outcome("scoop-1", roster: ["scoop-1"]), .select)
    }
}
