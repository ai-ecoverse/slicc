import SliccTrayKit
import UIKit

var trayFollowerMotd: String {
    let device = UIDevice.current
    return "Sliccy iOS follower on \(device.name) (\(device.systemName) \(device.systemVersion)) — only supported command: open"
}
