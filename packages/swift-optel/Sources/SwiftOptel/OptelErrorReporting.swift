import Foundation

/// Resolved `source` / `target` pair for an `error` checkpoint.
///
/// Mapping is bridge-based so it works uniformly for Swift `Error` values
/// (bridged to `NSError`) and Objective-C `NSException` instances surfaced by
/// the uncaught-exception hook.
public struct OptelErrorMapping: Hashable, Sendable {
    /// The grouping key (error domain or exception name).
    public let source: String
    /// The free-form detail (localized description, reason, or code).
    public let target: String

    public init(source: String, target: String) {
        self.source = source
        self.target = target
    }

    /// Map a Swift `Error`. Uses the bridged `NSError.domain` as `source`
    /// (which yields `<Module>.<TypeName>` for plain Swift error enums) and
    /// `localizedDescription` as `target`.
    public static func from(error: Error) -> OptelErrorMapping {
        let nsError = error as NSError
        let domain = nsError.domain.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = domain.isEmpty ? String(describing: type(of: error)) : domain
        let description = nsError.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let target = description.isEmpty ? String(nsError.code) : description
        return OptelErrorMapping(source: source, target: target)
    }

    /// Map an Objective-C `NSException`. Uses `name.rawValue` as `source` and
    /// `reason` (or `description`) as `target`.
    public static func from(exception: NSException) -> OptelErrorMapping {
        let rawName = exception.name.rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let source = rawName.isEmpty ? "NSException" : rawName
        let reason = (exception.reason ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let target = reason.isEmpty ? exception.description : reason
        return OptelErrorMapping(source: source, target: target)
    }
}

extension Optel {
    /// Report a Swift `Error` as an `error` checkpoint. `source` and `target`
    /// are derived from the error's bridged `NSError` representation.
    public func reportError(_ error: Error) {
        let mapping = OptelErrorMapping.from(error: error)
        sample(.error, source: mapping.source, target: mapping.target)
    }

    /// Static convenience: report an error on the shared singleton.
    public static func reportError(_ error: Error) {
        shared.reportError(error)
    }
}

/// Module-private holder for the handler that was installed before
/// ``OptelUncaughtExceptionHook/installIfNeeded()`` ran. `NSSetUncaughtExceptionHandler`
/// takes a C function pointer, so the trampoline below cannot capture the
/// previous handler in a closure and must reach it via this file-scope `var`.
private var optelPreviousUncaughtExceptionHandler: (@convention(c) (NSException) -> Void)?

/// File-scope C trampoline registered with `NSSetUncaughtExceptionHandler`.
/// Emits an `error` checkpoint on the shared ``Optel`` and then chains to the
/// previously-installed handler so crash reporters keep working.
private func optelUncaughtExceptionTrampoline(_ exception: NSException) {
    let mapping = OptelErrorMapping.from(exception: exception)
    Optel.shared.sample(.error, source: mapping.source, target: mapping.target)
    optelPreviousUncaughtExceptionHandler?(exception)
}

/// Install / inspect the best-effort uncaught-exception hook used by the
/// SwiftUI auto-instrument modifier.
///
/// The hook catches Objective-C `NSException`s only — Swift errors are values,
/// not exceptions, and cannot be intercepted globally. The previously-installed
/// handler (if any) is chained so this plays nicely with crash reporters that
/// also hook `NSSetUncaughtExceptionHandler`.
public enum OptelUncaughtExceptionHook {
    private static let lock = NSLock()
    private static var installed = false

    /// `true` once the hook has been installed for this process.
    public static var isInstalled: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install the hook if it has not been installed yet. Safe to call from
    /// any thread; subsequent calls are no-ops.
    public static func installIfNeeded() {
        lock.lock()
        guard !installed else {
            lock.unlock()
            return
        }
        installed = true
        optelPreviousUncaughtExceptionHandler = NSGetUncaughtExceptionHandler()
        lock.unlock()
        NSSetUncaughtExceptionHandler(optelUncaughtExceptionTrampoline)
    }

    /// Test-only reset of the install latch. Does **not** uninstall the
    /// handler from the runtime (the system API only allows replacement).
    internal static func _testing_reset() {
        lock.lock()
        installed = false
        lock.unlock()
    }
}
