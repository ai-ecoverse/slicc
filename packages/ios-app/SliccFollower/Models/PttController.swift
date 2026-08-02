import Foundation

// MARK: - Stage

/// One gesture outcome. `id` makes consecutive identical outcomes distinct
/// so `.onChange` fires for each (two quick taps in a row must both focus).
struct PttEvent: Equatable {
    enum Kind: Equatable {
        /// Final non-empty transcript, trimmed — append + submit it.
        case commit(String)
        /// The press ended as a plain tap (or nothing was heard) — restore
        /// the native behavior the surface intercepted: focus the field.
        case quickTap
    }

    let id: UUID
    let kind: Kind

    init(_ kind: Kind) {
        id = UUID()
        self.kind = kind
    }
}

/// Where an active push-to-talk press is in its lifecycle. `idle` means no
/// overlay is mounted. Mirrors `PttStage` in
/// `packages/webcomponents/src/composer/slicc-composer.ts`, minus `picking`:
/// iOS routes the active microphone at the system level (AirPods and wired
/// mics take over automatically), so there is deliberately no device picker.
enum PttStage: Equatable {
    case idle
    /// Hold-to-enable bar sweeping; completing the hold requests permission.
    case enable
    /// The system permission prompt is up (or the request is in flight).
    case prompting
    /// Blocked. The associated message overrides the default "flip it in
    /// Settings" instructions when the block has a different fix (restricted
    /// devices, a stalled request).
    case denied(message: String?)
    case recording
    /// Released — waiting for the recognizer's final transcript.
    case finalizing
}

// MARK: - Scheduling seam

/// Timer seam so unit tests drive the engage/enable delays by hand instead
/// of sleeping through them. Returns a cancel closure.
protocol PttScheduling {
    func schedule(afterMs: Int, _ work: @escaping @MainActor () -> Void) -> () -> Void
}

struct MainQueuePttScheduler: PttScheduling {
    func schedule(afterMs: Int, _ work: @escaping @MainActor () -> Void) -> () -> Void {
        let item = DispatchWorkItem {
            Task { @MainActor in work() }
        }
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(afterMs), execute: item)
        return { item.cancel() }
    }
}

// MARK: - Controller

/// The push-to-talk state machine, ported from `<slicc-composer>`'s gesture
/// (`packages/webcomponents/src/composer/slicc-composer.ts`). The view owns
/// touches (down / up / system-cancel); this controller owns every timer and
/// transition, so the whole lifecycle is unit-testable with a fake engine
/// and a hand-cranked scheduler.
///
/// Web timings are kept verbatim: a plain tap (released inside the 400 ms
/// engage window) never flashes the overlay, and the 1 s hold-to-enable gate
/// stands between an undetermined permission and the system prompt.
@MainActor
final class PttController: ObservableObject {
    /// Delay between touch-down and arming the lifecycle (`PTT_ENGAGE_MS`).
    static let engageMs = 400
    /// Hold length before the permission request fires (`HOLD_TO_ENABLE_MS`).
    static let holdToEnableMs = 1000
    /// The caption line keeps only the trailing words (`CAPTION_MAX_WORDS`).
    static let captionMaxWords = 8

    @Published private(set) var stage: PttStage = .idle
    /// The closed-caption line while recording (trailing words of the interim
    /// transcript), or an error note when `captionIsError`.
    @Published private(set) var caption = ""
    @Published private(set) var captionIsError = false
    /// The gesture's outcome, published as an event rather than delivered
    /// through a stored callback: a SwiftUI view must handle it from
    /// `.onChange` (re-registered every render) so the handler sees CURRENT
    /// view state — a closure stored once at `onAppear` captures the value
    /// snapshot from before e.g. the connection state settled, and a commit
    /// routed through it silently fails the composer's guards.
    @Published private(set) var event: PttEvent?

    var engineStatusLine: String { engine.statusLine }

    private let engine: DictationEngine
    private let scheduler: PttScheduling
    /// Bounds `requestPermission` (`PERMISSION_REQUEST_TIMEOUT_MS`): a grant
    /// flow that never settles must not freeze the overlay at "prompting".
    private let permissionTimeoutMs: Int
    /// Bounds the release → stop() → commit chain (`FINALIZE_TIMEOUT_MS`).
    private let finalizeTimeoutMs: Int

    private var pressed = false
    /// Monotonic press counter — async continuations from a stale press bail.
    private var token = 0
    private var cancelEngage: (() -> Void)?
    private var cancelEnable: (() -> Void)?
    private var session: DictationSession?
    /// An in-flight `engine.start()`. Whoever nulls this slot owns the
    /// eventual session (web parity with `#startingSession`): a release that
    /// lands before start() resolves awaits it so captured audio is
    /// transcribed, not dropped; a cancel awaits it to tear the session
    /// down; the resolve continuation adopts it only while the slot still
    /// holds its own handle.
    private var startHandle: StartHandle?

    /// Reference wrapper so continuations can check slot ownership by
    /// identity (`Task` itself is a value type).
    private final class StartHandle {
        let task: Task<DictationSession?, Never>
        init(_ task: Task<DictationSession?, Never>) { self.task = task }
    }

    init(
        engine: DictationEngine,
        scheduler: PttScheduling = MainQueuePttScheduler(),
        permissionTimeoutMs: Int = 10_000,
        finalizeTimeoutMs: Int = 45_000
    ) {
        self.engine = engine
        self.scheduler = scheduler
        self.permissionTimeoutMs = permissionTimeoutMs
        self.finalizeTimeoutMs = finalizeTimeoutMs
    }

    // MARK: Touch input

    func pressDown() {
        guard !pressed, stage == .idle else { return }
        pressed = true
        token += 1
        let t = token
        cancelEngage = scheduler.schedule(afterMs: Self.engageMs) { [weak self] in
            guard let self else { return }
            self.cancelEngage = nil
            self.engaged(t)
        }
    }

    func pressUp() {
        guard pressed else { return }
        pressed = false
        if let cancel = cancelEngage {
            // Released inside the engage window: a plain tap. The overlay
            // never flashed and the engine was never touched.
            cancel()
            cancelEngage = nil
            token += 1
            event = PttEvent(.quickTap)
            return
        }
        switch stage {
        case .enable:
            cancelEnable?()
            cancelEnable = nil
            reset()
        case .prompting:
            // The system prompt steals the touch, so a release here is
            // expected — the permission continuation owns teardown.
            break
        case .recording:
            finalize()
        default:
            reset()
        }
    }

    /// The system cancelled the touch mid-press (incoming call, control
    /// center swipe). Tear down without inserting.
    func pressCancelled() {
        guard pressed else { return }
        pressed = false
        cancelEngage?()
        cancelEngage = nil
        cancelEnable?()
        cancelEnable = nil
        session?.cancel()
        session = nil
        cancelPendingStart()
        if case .prompting = stage { return }
        reset()
    }

    // MARK: Lifecycle

    private func engaged(_ t: Int) {
        guard pressed, t == token else { return }
        switch engine.permission {
        case .granted:
            startRecording(t)
        case .denied:
            stage = .denied(message: nil)
        case .restricted:
            stage = .denied(message: Self.restrictedMessage)
        case .undetermined:
            stage = .enable
            cancelEnable = scheduler.schedule(afterMs: Self.holdToEnableMs) { [weak self] in
                guard let self else { return }
                self.cancelEnable = nil
                self.holdComplete(t)
            }
        }
    }

    private func holdComplete(_ t: Int) {
        guard pressed, t == token, stage == .enable else { return }
        stage = .prompting
        let timeoutMs = permissionTimeoutMs
        Task { @MainActor [weak self] in
            guard let engine = self?.engine else { return }
            let outcome: DictationPermission? = await Self.withTimeout(
                ms: timeoutMs, fallback: nil
            ) {
                await engine.requestPermission()
            }
            guard let self, t == self.token else { return }
            switch outcome {
            case .granted:
                if self.pressed {
                    self.startRecording(t)
                } else {
                    // Released while the native prompt was up — granted and
                    // armed for the next hold.
                    self.reset()
                }
            case .restricted:
                if self.pressed {
                    self.stage = .denied(message: Self.restrictedMessage)
                } else {
                    self.reset()
                }
            case .denied, .undetermined:
                if self.pressed {
                    self.stage = .denied(message: nil)
                } else {
                    self.reset()
                }
            case nil:
                // The request stalled past the timeout — surface why instead
                // of freezing at "prompting" forever.
                if self.pressed {
                    self.stage = .denied(
                        message: "The microphone didn't respond. Check Settings, then hold again.")
                } else {
                    self.reset()
                }
            }
        }
    }

    private func startRecording(_ t: Int) {
        stage = .recording
        caption = ""
        captionIsError = false
        let engine = engine
        let task = Task<DictationSession?, Never> { @MainActor [weak self] in
            do {
                return try await engine.start(
                    onPartial: { [weak self] text in
                        guard let self, t == self.token else { return }
                        self.caption = Self.trailingWords(text)
                        self.captionIsError = false
                    },
                    onError: { [weak self] message in
                        guard let self, t == self.token else { return }
                        self.caption = message
                        self.captionIsError = true
                    })
            } catch {
                if let self, t == self.token {
                    self.caption = error.localizedDescription
                    self.captionIsError = true
                }
                return nil
            }
        }
        let handle = StartHandle(task)
        startHandle = handle
        Task { @MainActor [weak self] in
            let session = await task.value
            guard let self else {
                session?.cancel()
                return
            }
            // A finalize/cancel that landed first took the slot and owns the
            // session — bail so we neither double-handle nor cancel a session
            // the user wants transcribed.
            guard self.startHandle === handle else { return }
            self.startHandle = nil
            guard t == self.token, self.stage == .recording else {
                session?.cancel()
                return
            }
            self.session = session
        }
    }

    private func finalize() {
        let t = token
        let live = session
        session = nil
        let pending = startHandle
        startHandle = nil
        guard live != nil || pending != nil else {
            // The engine never came up — keep the press a plain focus.
            reset()
            event = PttEvent(.quickTap)
            return
        }
        stage = .finalizing
        caption = "Transcribing…"
        captionIsError = false
        let timeoutMs = finalizeTimeoutMs
        Task { @MainActor [weak self] in
            let text = await Self.withTimeout(ms: timeoutMs, fallback: "") {
                if let live { return await live.stop() }
                guard let session = await pending?.task.value else { return "" }
                return await session.stop()
            }
            guard let self, t == self.token else { return }
            self.reset()
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                // Nothing heard — leave the press as a plain focus.
                self.event = PttEvent(.quickTap)
            } else {
                self.event = PttEvent(.commit(trimmed))
            }
        }
    }

    private func cancelPendingStart() {
        guard let pending = startHandle else { return }
        startHandle = nil
        Task { @MainActor in
            (await pending.task.value)?.cancel()
        }
    }

    private func reset() {
        stage = .idle
        caption = ""
        captionIsError = false
        token += 1
    }

    #if DEBUG
        /// Screenshot seam (`-uiTestPttStage`): pin the overlay to a stage
        /// without a touch. The overlay only exists mid-hold, so the PR
        /// screenshots job could not reach it otherwise. DEBUG-only — a
        /// shipped binary must not carry a flag that fakes recording UI.
        func forceStage(_ stage: PttStage, caption: String = "") {
            self.stage = stage
            self.caption = caption
        }
    #endif

    // MARK: Helpers

    static let restrictedMessage =
        "Speech recognition is restricted on this device (Screen Time or a profile), "
        + "so push to talk is unavailable."

    /// Keep only the trailing words, like movie closed captions.
    static func trailingWords(_ text: String) -> String {
        let words = text.split(whereSeparator: \.isWhitespace)
        return words.suffix(captionMaxWords).joined(separator: " ")
    }

    /// Race `operation` against a deadline; `fallback` when the deadline
    /// wins. Non-throwing analogue of the web's `withTimeout`.
    ///
    /// Deliberately NOT a task group: a group only exits once every child
    /// has completed, and cancellation is cooperative — an operation
    /// suspended in a checked continuation (a permission callback that
    /// never fires, a recognizer that never finalizes) would keep the
    /// group, and therefore the overlay, stuck past the advertised
    /// deadline. Here the loser is simply abandoned: both racers funnel
    /// into a resume-once gate, and a stalled operation parks harmlessly
    /// while the UI recovers.
    private static func withTimeout<T: Sendable>(
        ms: Int,
        fallback: T,
        operation: @escaping @MainActor @Sendable () async -> T
    ) async -> T {
        await withCheckedContinuation { (continuation: CheckedContinuation<T, Never>) in
            let gate = ResumeOnceGate(continuation)
            Task { @MainActor in
                gate.resume(await operation())
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                gate.resume(fallback)
            }
        }
    }

    /// First racer through wins; later resumes are no-ops. MainActor-bound,
    /// so no lock is needed.
    @MainActor
    private final class ResumeOnceGate<T: Sendable> {
        private var continuation: CheckedContinuation<T, Never>?

        init(_ continuation: CheckedContinuation<T, Never>) {
            self.continuation = continuation
        }

        func resume(_ value: T) {
            continuation?.resume(returning: value)
            continuation = nil
        }
    }
}
