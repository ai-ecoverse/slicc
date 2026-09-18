import Foundation
import SliccTrayFollower







@MainActor
protocol TrayFollowerConnecting: AnyObject {
    var delegate: TrayFollowerConnectorDelegate? { get set }
    func start() async throws
    func stop()
}

extension TrayFollowerConnector: TrayFollowerConnecting {}


typealias WidgetTrayConnecting = TrayFollowerConnecting
