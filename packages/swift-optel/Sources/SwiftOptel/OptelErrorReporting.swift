import Foundation






public struct OptelErrorMapping: Hashable, Sendable {
    
    public let source: String
    
    public let target: String

    public init(source: String, target: String) {
        self.source = source
        self.target = target
    }

    
    
    
    public static func from(error: Error) -> OptelErrorMapping {
        let nsError = error as NSError
        let domain = nsError.domain.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = domain.isEmpty ? String(describing: type(of: error)) : domain
        let description = nsError.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let target = description.isEmpty ? String(nsError.code) : description
        return OptelErrorMapping(source: source, target: target)
    }

    
    
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
    
    
    public func reportError(_ error: Error) {
        let mapping = OptelErrorMapping.from(error: error)
        sample(.error, source: mapping.source, target: mapping.target)
    }

    
    public static func reportError(_ error: Error) {
        shared.reportError(error)
    }
}





private var optelPreviousUncaughtExceptionHandler: (@convention(c) (NSException) -> Void)?

private func optelTestingNoopUncaughtHandler(_ exception: NSException) {}




private func optelUncaughtExceptionTrampoline(_ exception: NSException) {
    let mapping = OptelErrorMapping.from(exception: exception)
    Optel.shared.sample(.error, source: mapping.source, target: mapping.target)
    optelPreviousUncaughtExceptionHandler?(exception)
}








public enum OptelUncaughtExceptionHook {
    private static let lock = NSLock()
    private static var installed = false

    
    public static var isInstalled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return installed
    }

    
    
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

    
    
    internal static func _testing_reset() {
        lock.lock()
        installed = false
        lock.unlock()
    }

    
    
    
    internal static func _testing_invokeTrampoline(_ exception: NSException) {
        let saved = optelPreviousUncaughtExceptionHandler
        optelPreviousUncaughtExceptionHandler = optelTestingNoopUncaughtHandler
        optelUncaughtExceptionTrampoline(exception)
        optelPreviousUncaughtExceptionHandler = saved
    }
}
