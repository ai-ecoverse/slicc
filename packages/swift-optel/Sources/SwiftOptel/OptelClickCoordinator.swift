import Foundation



































public enum OptelClickCoordinator {
    private static let lock = NSLock()
    private static var pendingEpoch: UInt64 = 0
    private static var refinedClaimEpoch: UInt64?

    
    
    
    @discardableResult
    public static func beginMonitorEvent() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        pendingEpoch &+= 1
        return pendingEpoch
    }

    
    
    
    public static func claimByRefined() {
        lock.lock()
        defer { lock.unlock() }
        refinedClaimEpoch = pendingEpoch
    }

    
    
    public static func wasClaimedByRefined(epoch: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return refinedClaimEpoch == epoch
    }

    
    
    internal static func _testing_reset() {
        lock.lock()
        defer { lock.unlock() }
        pendingEpoch = 0
        refinedClaimEpoch = nil
    }
}
