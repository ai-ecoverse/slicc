import Dispatch
import Foundation

/// Deadline wrapper for the synchronous persisted-secret store calls that sit
/// on HTTP request paths.
///
/// `SecretStore` talks to the macOS Keychain through `SecItemCopyMatching` /
/// `SecItemUpdate`, which are synchronous and **uncancellable**. When the item's
/// ACL does not yet trust this binary, those calls sit on an "allow access"
/// dialog. A request from a browser tab has nobody at a keyboard to answer it,
/// and neither Hummingbird (no `idleTimeout` by default) nor the webapp's
/// `secret` backend bounded the wait — so `GET /api/secrets` blocked forever and
/// `secret list` never returned.
///
/// The call therefore runs on a Dispatch queue rather than a cooperative thread
/// (blocking one of those would starve unrelated async work), and whichever
/// finishes first — the call or the deadline — wins.
///
/// **The abandoned call keeps running.** There is no way to cancel a blocked
/// `SecItem*`; it holds its Dispatch thread until the dialog is answered or
/// dismissed. That is accepted deliberately: an abandoned background thread is
/// strictly better than a wedged request, and the leak is bounded by how many
/// times a user retries. Do not "fix" it by waiting for the call.
enum BoundedStoreCall {
    /// Deadline for one persisted-store call. Generous next to a granted
    /// Keychain read (sub-millisecond in practice) and far below the webapp's
    /// 10 s control-plane budget, so the server answers before the client gives
    /// up and the user sees the server's actionable message rather than a bare
    /// client timeout.
    static let defaultTimeoutSeconds: TimeInterval = 5

    /// Diagnosis returned to the caller when a store call misses its deadline.
    /// Names the likely cause and the fix; mentions no secret names or values.
    static let timeoutMessage =
        "saved-secret store did not respond within \(Int(defaultTimeoutSeconds))s — on Sliccstart this "
        + "usually means the macOS Keychain access dialog is waiting unanswered (every rebuild re-raises "
        + "it for the new binary). Allow access for this build, or run "
        + "packages/dev-tools/tools/setup-dev-cert.sh for a grant that survives rebuilds; see "
        + "docs/secrets.md. Session secrets are unaffected."

    /// Machine-readable companion to {@link timeoutMessage}.
    static let timeoutErrorCode = "persisted-store-unavailable"

    /// Run a non-throwing store call. Returns `nil` on deadline miss.
    static func run<T: Sendable>(
        timeoutSeconds: TimeInterval = defaultTimeoutSeconds,
        _ body: @escaping @Sendable () -> T
    ) async -> T? {
        await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
            let once = OneShotResumer<T?>(continuation)
            DispatchQueue.global(qos: .userInitiated).async { once.resume(body()) }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeoutSeconds) {
                once.resume(nil)
            }
        }
    }

    /// Run a throwing store call (the write paths). Returns `nil` on deadline
    /// miss; a thrown store error still surfaces as `.failure` so callers keep
    /// reporting it exactly as they did before.
    static func runThrowing<T: Sendable>(
        timeoutSeconds: TimeInterval = defaultTimeoutSeconds,
        _ body: @escaping @Sendable () throws -> T
    ) async -> Result<T, Error>? {
        await run(timeoutSeconds: timeoutSeconds) { Result { try body() } }
    }
}

/// Resumes a continuation at most once, whichever racer gets there first.
/// A continuation resumed twice traps, and one never resumed leaks the task —
/// so the winner is decided under a lock.
private final class OneShotResumer<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: T) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}
