import Dispatch
import Foundation

enum BoundedStoreCall {

    static let defaultTimeoutSeconds: TimeInterval = 5

    static let timeoutMessage =
        "saved-secret store did not respond within \(Int(defaultTimeoutSeconds))s — on Sliccstart this "
        + "usually means the macOS Keychain access dialog is waiting unanswered (every rebuild re-raises "
        + "it for the new binary). Allow access for this build, or run "
        + "packages/dev-tools/tools/setup-dev-cert.sh for a grant that survives rebuilds; see "
        + "docs/secrets.md. Session secrets are unaffected."

    static let timeoutErrorCode = "persisted-store-unavailable"

    static let writeTimeoutMessage =
        "saved-secret store did not respond within \(Int(defaultTimeoutSeconds))s, so this write's outcome "
        + "is unknown — it may still be applied once the macOS Keychain access dialog is answered. Nothing "
        + "was rolled back: check `secret list` before retrying so a rotation is not applied twice. See "
        + "docs/secrets.md."

    static let writeTimeoutErrorCode = "persisted-store-write-unknown"

    static func run<T: Sendable>(
        timeoutSeconds: TimeInterval = defaultTimeoutSeconds,
        onLateCompletion: (@Sendable (T) -> Void)? = nil,
        _ body: @escaping @Sendable () -> T
    ) async -> T? {
        await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
            let once = OneShotResumer<T?>(continuation)
            DispatchQueue.global(qos: .userInitiated).async {
                let value = body()
                if !once.resume(value) { onLateCompletion?(value) }
            }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeoutSeconds) {
                _ = once.resume(nil)
            }
        }
    }

    static func runThrowing<T: Sendable>(
        timeoutSeconds: TimeInterval = defaultTimeoutSeconds,
        onLateCompletion: (@Sendable (Result<T, Error>) -> Void)? = nil,
        _ body: @escaping @Sendable () throws -> T
    ) async -> Result<T, Error>? {
        await run(timeoutSeconds: timeoutSeconds, onLateCompletion: onLateCompletion) {
            Result { try body() }
        }
    }
}

private final class OneShotResumer<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    @discardableResult
    func resume(_ value: T) -> Bool {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
        return pending != nil
    }
}
