import SwiftUI
import UIKit
import XCTest

@testable import SliccFollower

@MainActor
final class GhosttyTerminalSpikeViewTests: XCTestCase {
    func testRendersCannedOutput() async {
        let spikeView = GhosttyTerminalSpikeView()
        let host = UIHostingController(rootView: spikeView)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        defer { window.isHidden = true }

        for _ in 0..<100 {
            if spikeView.session.readViewportText()?.contains("SLICC libghostty spike") == true {
                return
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTFail("Ghostty terminal did not render the canned host output")
    }
}
