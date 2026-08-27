import Foundation

/// The app a widget belongs to. The two hosts differ in exactly three ways —
/// the app group they share, the name the widget tells the user to open, and
/// the URL scheme a tap goes back through — so they are three fields rather
/// than two copies of every view.
public struct WidgetHost: Sendable, Equatable {
    /// What the user calls the app ("Sliccy", "Sliccstart").
    public let appName: String
    /// Shared container the host writes snapshots into.
    public let appGroup: String
    /// Scheme a widget tap opens, or `nil` where a tap should just launch the
    /// app (macOS, until Sliccstart routes unit selection).
    public let urlScheme: String?

    public init(appName: String, appGroup: String, urlScheme: String?) {
        self.appName = appName
        self.appGroup = appGroup
        self.urlScheme = urlScheme
    }

    /// The iOS follower. The group already carries the share extension's inbox
    /// and the File Provider's join URL; the widget is its third member.
    public static let follower = WidgetHost(
        appName: "Sliccy",
        appGroup: "group.ai.sliccy.follower",
        urlScheme: "slicc"
    )

    /// The macOS launcher. Its group is team-prefixed and still carries the
    /// File Provider's name — renaming it would strand the provider's saved
    /// join URL, so the widget joins the existing group instead.
    public static let sliccstart = WidgetHost(
        appName: "Sliccstart",
        appGroup: "S8LB56P782.com.slicc.sliccstart.fileprovider",
        urlScheme: nil
    )

    public var store: WidgetSnapshotStore { WidgetSnapshotStore(appGroup: appGroup) }

    /// Where a tap on `unit` should land. Nil hands WidgetKit the default
    /// "open the app" behaviour.
    ///
    /// NOT WIRED: no app parses this route yet. It is here so the design can
    /// be reviewed with taps in it, and so wiring it is a route handler rather
    /// than a re-layout.
    public func url(forUnit unit: WidgetUnit) -> URL? {
        guard let urlScheme else { return nil }
        var components = URLComponents()
        components.scheme = urlScheme
        components.host = "unit"
        components.queryItems = [URLQueryItem(name: "jid", value: unit.id)]
        return components.url
    }
}
