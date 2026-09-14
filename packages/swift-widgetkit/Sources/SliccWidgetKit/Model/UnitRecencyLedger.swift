import Foundation














public struct UnitRecencyLedger {
    private var stamps: [String: Date] = [:]
    private var fingerprints: [String: String] = [:]

    public init() {}

    
    
    
    
    
    
    public mutating func stamp(_ units: [WidgetUnit], now: Date) -> [WidgetUnit] {
        var nextStamps: [String: Date] = [:]
        var nextFingerprints: [String: String] = [:]
        let stamped = units.map { unit -> WidgetUnit in
            let fingerprint = unit.activityFingerprint
            let changed = fingerprints[unit.id] != fingerprint
            let at = changed ? now : (stamps[unit.id] ?? now)
            nextStamps[unit.id] = at
            nextFingerprints[unit.id] = fingerprint
            return unit.stamped(lastActivityAt: at)
        }
        stamps = nextStamps
        fingerprints = nextFingerprints
        return stamped
    }
}

extension WidgetUnit {
    
    public func stamped(lastActivityAt: Date?) -> WidgetUnit {
        WidgetUnit(
            id: id, name: name, role: role, parentId: parentId, lifecycle: lifecycle,
            activity: activity, fill: fill, model: model, detail: detail, isActive: isActive,
            lastActivityAt: lastActivityAt)
    }
}
