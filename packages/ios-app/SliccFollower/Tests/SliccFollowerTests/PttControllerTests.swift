import Combine
import XCTest

@testable import SliccFollower

/// The push-to-talk state machine, driven synchronously via a hand-cranked
/// scheduler and a controllable fake engine. Timings and transitions mirror
/// the web composer's gesture (`slicc-composer.ts`) — the tests assert the
/// ported semantics, not SwiftUI rendering.
@MainActor
final class PttControllerTests: XCTestCase {

    // MARK: Fakes

    /// Records scheduled timers; the test fires them by hand.
    final class FakeScheduler: PttScheduling {
        final class Entry {
            let afterMs: Int
            let work: @MainActor () -> Void
            var cancelled = false

            init(afterMs: Int, work: @escaping @MainActor () -> Void) {
                self.afterMs = afterMs
                self.work = work
            }
        }

        private(set) var entries: [Entry] = []

        func schedule(afterMs: Int, _ work: @escaping @MainActor () -> Void) -> () -> Void {
            let entry = Entry(afterMs: afterMs, work: work)
            entries.append(entry)
            return { entry.cancelled = true }
        }

        /// Fire the next pending (uncancelled) timer.
        @MainActor
        func fireNext() {
            guard let index = entries.firstIndex(where: { !$0.cancelled }) else {
                XCTFail("no pending timer to fire")
                return
            }
            let entry = entries.remove(at: index)
            entry.work()
        }

        var pendingCount: Int { entries.filter { !$0.cancelled }.count }
    }

    final class FakeSession: DictationSession {
        let transcript: String
        private(set) var stopped = false
        private(set) var cancelled = false

        init(transcript: String) { self.transcript = transcript }

        func stop() async -> String {
            stopped = true
            return transcript
        }

        func cancel() { cancelled = true }
    }

    final class FakeEngine: DictationEngine {
        var permission: DictationPermission
        var grantOutcome: DictationPermission = .granted
        var transcript = ""
        var statusLine = "Fake engine"
        private(set) var permissionRequests = 0
        private(set) var startCount = 0
        private(set) var lastSession: FakeSession?
        var lastPartial: (@MainActor @Sendable (String) -> Void)?
        /// When set, `requestPermission` never resolves (timeout path).
        var stallPermission = false

        init(permission: DictationPermission) { self.permission = permission }

        func requestPermission() async -> DictationPermission {
            permissionRequests += 1
            if stallPermission {
                // Far beyond any test's timeout budget.
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
            permission = grantOutcome
            return grantOutcome
        }

        func start(
            onPartial: @escaping @MainActor @Sendable (String) -> Void,
            onError: @escaping @MainActor @Sendable (String) -> Void
        ) async throws -> DictationSession {
            startCount += 1
            lastPartial = onPartial
            let session = FakeSession(transcript: transcript)
            lastSession = session
            return session
        }
    }

    // MARK: Helpers

    private func makeController(
        engine: FakeEngine,
        scheduler: FakeScheduler,
        permissionTimeoutMs: Int = 10_000
    ) -> (PttController, Committed) {
        let controller = PttController(
            engine: engine,
            scheduler: scheduler,
            permissionTimeoutMs: permissionTimeoutMs,
            finalizeTimeoutMs: 5000
        )
        let committed = Committed()
        committed.cancellable = controller.$event
            .compactMap { $0 }
            .sink { event in
                switch event.kind {
                case .commit(let transcript): committed.transcripts.append(transcript)
                case .quickTap: committed.quickTaps += 1
                }
            }
        return (controller, committed)
    }

    /// Collects the controller's published outcome events (the view consumes
    /// them via `.onChange`; tests via a sink).
    final class Committed {
        var transcripts: [String] = []
        var quickTaps = 0
        var cancellable: AnyCancellable?
    }

    /// Pump the main actor until `condition` holds (the controller settles
    /// its async continuations in a few hops).
    private func waitUntil(
        _ condition: @autoclosure @MainActor () -> Bool,
        timeout: TimeInterval = 2
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    // MARK: Tests

    func testQuickTapNeverTouchesTheEngine() {
        let engine = FakeEngine(permission: .granted)
        let scheduler = FakeScheduler()
        let (controller, committed) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        XCTAssertEqual(controller.stage, .idle, "the engage window must not flash the overlay")
        controller.pressUp()

        XCTAssertEqual(controller.stage, .idle)
        XCTAssertEqual(committed.quickTaps, 1, "a quick tap restores focus")
        XCTAssertEqual(engine.startCount, 0)
        XCTAssertEqual(scheduler.pendingCount, 0, "the engage timer was cancelled")
    }

    func testGrantedHoldRecordsAndCommitsOnRelease() async {
        let engine = FakeEngine(permission: .granted)
        engine.transcript = "hello from dictation"
        let scheduler = FakeScheduler()
        let (controller, committed) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()  // engage → permission already granted → recording
        XCTAssertEqual(controller.stage, .recording)

        await waitUntil(engine.startCount == 1)
        engine.lastPartial?("one two three")
        XCTAssertEqual(controller.caption, "one two three")

        controller.pressUp()
        XCTAssertEqual(controller.stage, .finalizing)
        await waitUntil(committed.transcripts.count == 1)
        XCTAssertEqual(committed.transcripts, ["hello from dictation"])
        XCTAssertEqual(controller.stage, .idle)
        XCTAssertEqual(engine.lastSession?.stopped, true)
    }

    func testCaptionKeepsOnlyTrailingWords() async {
        let engine = FakeEngine(permission: .granted)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        await waitUntil(engine.startCount == 1)

        engine.lastPartial?("one two three four five six seven eight nine ten")
        XCTAssertEqual(
            controller.caption, "three four five six seven eight nine ten",
            "the caption keeps the trailing \(PttController.captionMaxWords) words")
    }

    func testUndeterminedRunsTheEnableGateThenPrompts() async {
        let engine = FakeEngine(permission: .undetermined)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()  // engage
        XCTAssertEqual(controller.stage, .enable)
        XCTAssertEqual(engine.permissionRequests, 0, "the 1s gate stands before the prompt")

        scheduler.fireNext()  // hold-to-enable complete
        XCTAssertEqual(controller.stage, .prompting)
        await waitUntil(engine.permissionRequests == 1)
        // Grant resolved while still pressed → straight into recording.
        await waitUntil(controller.stage == .recording)
        XCTAssertEqual(engine.startCount, 1)
    }

    func testReleaseDuringEnableNeverPrompts() {
        let engine = FakeEngine(permission: .undetermined)
        let scheduler = FakeScheduler()
        let (controller, committed) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()  // engage → enable
        controller.pressUp()

        XCTAssertEqual(controller.stage, .idle)
        XCTAssertEqual(engine.permissionRequests, 0)
        XCTAssertEqual(committed.quickTaps, 0, "an aborted enable is not a tap")
        XCTAssertEqual(scheduler.pendingCount, 0, "the enable timer was cancelled")
    }

    func testDeniedShowsInstructionsAndReleaseDismisses() {
        let engine = FakeEngine(permission: .denied)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        XCTAssertEqual(controller.stage, .denied(message: nil))
        controller.pressUp()
        XCTAssertEqual(controller.stage, .idle)
        XCTAssertEqual(engine.startCount, 0)
    }

    func testRestrictedGetsItsOwnMessage() {
        let engine = FakeEngine(permission: .restricted)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        XCTAssertEqual(
            controller.stage, .denied(message: PttController.restrictedMessage),
            "restricted has no Settings toggle — the fix is different, so is the text")
    }

    func testGrantAfterReleaseArmsWithoutRecording() async {
        let engine = FakeEngine(permission: .undetermined)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()  // engage → enable
        scheduler.fireNext()  // → prompting (the system prompt steals the touch)
        controller.pressUp()
        XCTAssertEqual(controller.stage, .prompting, "the continuation owns teardown")

        await waitUntil(controller.stage == .idle)
        XCTAssertEqual(engine.permission, .granted, "granted and armed for the next hold")
        XCTAssertEqual(engine.startCount, 0, "released — never records")
    }

    func testDenialWhilePressedShowsBlocked() async {
        let engine = FakeEngine(permission: .undetermined)
        engine.grantOutcome = .denied
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        scheduler.fireNext()
        await waitUntil(controller.stage == .denied(message: nil))
        XCTAssertEqual(controller.stage, .denied(message: nil))
    }

    func testStalledPermissionRequestRecoversWithAMessage() async {
        let engine = FakeEngine(permission: .undetermined)
        engine.stallPermission = true
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(
            engine: engine, scheduler: scheduler, permissionTimeoutMs: 50)

        controller.pressDown()
        scheduler.fireNext()
        scheduler.fireNext()
        XCTAssertEqual(controller.stage, .prompting)
        await waitUntil(
            {
                if case .denied(let message) = controller.stage { return message != nil }
                return false
            }())
        guard case .denied(let message) = controller.stage else {
            return XCTFail("a stalled request must surface, not freeze the overlay")
        }
        XCTAssertNotNil(message)
    }

    func testEmptyTranscriptFallsBackToFocus() async {
        let engine = FakeEngine(permission: .granted)
        engine.transcript = "   "
        let scheduler = FakeScheduler()
        let (controller, committed) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        await waitUntil(engine.startCount == 1)
        controller.pressUp()

        await waitUntil(committed.quickTaps == 1)
        XCTAssertTrue(committed.transcripts.isEmpty, "nothing heard — nothing submitted")
        XCTAssertEqual(controller.stage, .idle)
    }

    func testSystemCancelTearsDownWithoutInserting() async {
        let engine = FakeEngine(permission: .granted)
        engine.transcript = "should never appear"
        let scheduler = FakeScheduler()
        let (controller, committed) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        scheduler.fireNext()
        await waitUntil(engine.startCount == 1)
        // Let the start continuation adopt the session before cancelling.
        await waitUntil(engine.lastSession != nil)
        try? await Task.sleep(nanoseconds: 50_000_000)

        controller.pressCancelled()
        XCTAssertEqual(controller.stage, .idle)
        await waitUntil(engine.lastSession?.cancelled == true)
        XCTAssertEqual(engine.lastSession?.cancelled, true)
        XCTAssertTrue(committed.transcripts.isEmpty)
        XCTAssertEqual(committed.quickTaps, 0)
    }

    func testSecondPressDownWhileActiveIsIgnored() {
        let engine = FakeEngine(permission: .granted)
        let scheduler = FakeScheduler()
        let (controller, _) = makeController(engine: engine, scheduler: scheduler)

        controller.pressDown()
        controller.pressDown()
        XCTAssertEqual(scheduler.pendingCount, 1, "a second finger must not stack a press")
    }
}
