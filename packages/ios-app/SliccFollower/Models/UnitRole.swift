import Foundation
import SliccTrayKit




enum UnitRole: String, Equatable, Sendable {
    case cone
    case scoop
}

extension UnitRole {
    
    
    
    
    
    
    
    
    var isReadOnly: Bool { self == .scoop }
}

extension ScoopSummary {
    
    
    
    
    
    
    
    
    
    
    
    var isRootUnit: Bool { parentId == nil && (isCone ?? true) }

    
    
    var role: UnitRole { isRootUnit ? .cone : .scoop }

    
    
    var isReadOnly: Bool { role.isReadOnly }
}
