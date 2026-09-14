import Foundation





public struct WidgetHost: Sendable, Equatable {
    
    public let appName: String
    
    public let appGroup: String
    
    
    public let urlScheme: String?

    public init(appName: String, appGroup: String, urlScheme: String?) {
        self.appName = appName
        self.appGroup = appGroup
        self.urlScheme = urlScheme
    }

    
    
    public static let follower = WidgetHost(
        appName: "Sliccy",
        appGroup: "group.ai.sliccy.follower",
        urlScheme: "slicc"
    )

    
    
    
    public static let sliccstart = WidgetHost(
        appName: "Sliccstart",
        appGroup: "S8LB56P782.com.slicc.sliccstart.fileprovider",
        urlScheme: nil
    )

    public var store: WidgetSnapshotStore { WidgetSnapshotStore(appGroup: appGroup) }

    
    
    
    
    
    
    public func url(forUnit unit: WidgetUnit) -> URL? {
        guard let urlScheme else { return nil }
        var components = URLComponents()
        components.scheme = urlScheme
        components.host = "unit"
        components.queryItems = [URLQueryItem(name: "jid", value: unit.id)]
        return components.url
    }
}
