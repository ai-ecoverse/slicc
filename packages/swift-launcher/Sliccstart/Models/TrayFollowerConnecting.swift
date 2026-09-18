import Foundation
import SliccTrayFollower

/// The slice of `TrayFollowerConnector` both launcher followers use, so their
/// wiring is testable without a leader, a network, or WebRTC.
///
/// `WidgetTrayObserver` and `ComputerTrayFollower` share this seam: the
/// widget follower is gated on installation, the computer follower always
/// dials when a leader join URL is set.
@MainActor
protocol TrayFollowerConnecting: AnyObject {
    var delegate: TrayFollowerConnectorDelegate? { get set }
    func start() async throws
    func stop()
}

extension TrayFollowerConnector: TrayFollowerConnecting {}

/// Kept so existing widget tests that name the protocol still compile.
typealias WidgetTrayConnecting = TrayFollowerConnecting
