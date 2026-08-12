import SliccTrayKit
import UIKit

// UIKit stays app-owned so SliccTrayKit remains safe for non-UI extensions.
/// One-line self-description surfaced by the leader's `ssh --list`, mirroring
/// the `motd` the Go CLI sets. Identifies the phone among several followers.
var trayFollowerMotd: String {
    let device = UIDevice.current
    return "Sliccy iOS follower on \(device.name) (\(device.systemName) \(device.systemVersion)) — only supported command: open"
}
