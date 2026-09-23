import Foundation
import SliccTrayFollower






typealias ComputerGrantTick = @Sendable () async -> Bool

enum ComputerGrantWatch {
    
    
    static let intervalSeconds: Double = 2

    static let liveTick: ComputerGrantTick = {
        let ns = UInt64((intervalSeconds * 1_000_000_000).rounded())
        return (try? await Task.sleep(nanoseconds: ns)) != nil
    }
}














enum ComputerCapabilityAdvertisement {
    static func capabilities(for grants: ComputerGrants) -> TraySyncCapabilities {
        TraySyncCapabilities(exec: false, computer: grants.canCaptureNatively)
    }

    
    
    static func motd(host: String, grants: ComputerGrants) -> String {
        switch (grants.screenRecording, grants.accessibility) {
        case (true, true):
            return "Native screen capture on \(host)"
        case (true, false):
            return
                "Native screen capture on \(host) — input needs Accessibility in System Settings → Privacy & Security"
        case (false, true):
            return
                "\(host): no native screen capture — grant Screen Recording in System Settings → Privacy & Security"
        case (false, false):
            return
                "\(host): no native screen capture or input — grant Screen Recording and Accessibility in System Settings → Privacy & Security"
        }
    }
}
