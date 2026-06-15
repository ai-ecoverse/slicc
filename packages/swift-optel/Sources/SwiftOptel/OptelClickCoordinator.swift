import Foundation

/// Coordinates click-beacon emission between the macOS global click monitor
/// (``OptelClickMonitor``) and the SwiftUI refinement points
/// (``OptelTapModifier``, ``OptelButton``) so a single user interaction never
/// produces two `click` beacons.
///
/// Why an explicit coordinator: with default ``View/optelAutoInstrument(appID:rate:globalHooks:)``,
/// the global `NSEvent` monitor is installed *and* refined controls still
/// emit their own higher-quality `click` from explicit handlers. Without
/// coordination, a single tap on an ``OptelButton`` produces two beacons —
/// one from the monitor's accessibility-derived path and one from the
/// button's wrapper. The coordinator solves that by letting the monitor
/// *defer* its emission until after SwiftUI has finished dispatching the
/// event, and letting refined handlers *claim* the in-flight monitor event
/// so the deferred emission is skipped.
///
/// Lifecycle:
/// 1. The monitor calls ``beginMonitorEvent()`` synchronously inside its
///    `NSEvent` callback. This returns a monotonically-increasing epoch
///    representing "the monitor would emit for this event".
/// 2. The monitor schedules its `Optel.sample(.click, …)` call on
///    `DispatchQueue.main.async` so it runs after the current event's
///    synchronous dispatch (including SwiftUI gesture handlers) has
///    completed.
/// 3. Refined handlers call ``claimByRefined()`` *during* event dispatch
///    (from inside `simultaneousGesture` or `Button(action:)`) right before
///    emitting their own `click`. This records the latest pending epoch as
///    "claimed".
/// 4. When the monitor's deferred block fires, it consults
///    ``wasClaimedByRefined(epoch:)`` for its own epoch. If claimed, the
///    monitor skips emission so only the refined beacon ships.
///
/// On iOS (and any other platform without the global monitor), refined
/// handlers still call ``claimByRefined()``; the claim is harmless because
/// no monitor ever checks it.
public enum OptelClickCoordinator {
    private static let lock = NSLock()
    private static var pendingEpoch: UInt64 = 0
    private static var refinedClaimEpoch: UInt64?

    /// Allocate a new epoch for an in-flight monitor event. Called
    /// synchronously by ``OptelClickMonitor`` immediately before scheduling
    /// the deferred emission.
    @discardableResult
    public static func beginMonitorEvent() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        pendingEpoch &+= 1
        return pendingEpoch
    }

    /// Mark the currently-pending monitor event as absorbed by a refined
    /// handler. Called by ``OptelTapModifier`` / ``OptelButton`` right before
    /// they emit their own `click`.
    public static func claimByRefined() {
        lock.lock(); defer { lock.unlock() }
        refinedClaimEpoch = pendingEpoch
    }

    /// Whether a refined handler claimed the supplied monitor `epoch`. Used
    /// by the monitor's deferred emission to decide whether to skip.
    public static func wasClaimedByRefined(epoch: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return refinedClaimEpoch == epoch
    }

    /// Test-only reset of every counter and claim. Mirrors the install-latch
    /// resets exposed by the other macOS hooks.
    internal static func _testing_reset() {
        lock.lock(); defer { lock.unlock() }
        pendingEpoch = 0
        refinedClaimEpoch = nil
    }
}
