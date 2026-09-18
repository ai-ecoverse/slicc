import Foundation

// MARK: - Computer roster (issue #3248)
//
// iOS is a viewer: it paints cards from `computers.list` / `computer.frame`
// and sends `computer.watch` / `computer.input`. Native capture
// (`computer.native.*`) is the macOS launcher path and is ignored here.

extension AppState {
    func handleComputerLeaderMessage(_ message: LeaderToFollowerMessage) {
        switch message {
        case .computersList(let computers):
            self.computers = computers
        case .computerFrame, .computerNativeCapture, .computerNativeUnwatch, .computerNativeInput:
            break
        default:
            break
        }
    }
}
