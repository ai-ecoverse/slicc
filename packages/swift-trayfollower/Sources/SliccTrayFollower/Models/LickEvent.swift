import Foundation



















public enum FollowerLickType: String, Codable {
    case navigate
    case discovery
}


public struct LickEvent: Codable, Equatable {
    public let type: FollowerLickType
    
    public let timestamp: String
    
    
    
    public let body: AnyCodable?

    
    public var navigateUrl: String?
    
    var discoveryOrigin: String?
    var discoveryKind: String?
    var discoveryUrl: String?
    
    
    
    public var targetScoop: String?

    public init(
        type: FollowerLickType,
        timestamp: String,
        body: AnyCodable?,
        navigateUrl: String? = nil,
        discoveryOrigin: String? = nil,
        discoveryKind: String? = nil,
        discoveryUrl: String? = nil,
        targetScoop: String? = nil
    ) {
        self.type = type
        self.timestamp = timestamp
        self.body = body
        self.navigateUrl = navigateUrl
        self.discoveryOrigin = discoveryOrigin
        self.discoveryKind = discoveryKind
        self.discoveryUrl = discoveryUrl
        self.targetScoop = targetScoop
    }
}
