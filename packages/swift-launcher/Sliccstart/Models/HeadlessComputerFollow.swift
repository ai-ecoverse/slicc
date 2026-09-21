import Foundation










@MainActor
final class HeadlessComputerFollow {
    private let follower: ComputerTrayFollower
    private let emit: (String) -> Void
    private let terminate: (Int32) -> Void
    private var reporter = ComputerFollowCLI.AttachReporter()

    
    
    
    
    init(
        follower: ComputerTrayFollower,
        emit: @escaping (String) -> Void,
        terminate: @escaping (Int32) -> Void
    ) {
        self.follower = follower
        self.emit = emit
        self.terminate = terminate
    }

    func start(joinUrl: String) {
        
        
        
        emit(ComputerFollowCLI.readyLine)
        follower.onConnected = { [weak self] in
            guard let self else { return }
            self.perform(self.reporter.connected())
        }
        follower.onGaveUp = { [weak self] reason in
            guard let self else { return }
            self.follower.stop()
            self.perform(self.reporter.gaveUp(reason))
        }
        follower.leaderChanged(joinUrl: joinUrl)
    }

    
    func signalled() { end(status: 0) }

    
    
    
    func parentExited() { end(status: 0) }

    private func end(status: Int32) {
        follower.stop()
        terminate(status)
    }

    private func perform(_ action: ComputerFollowCLI.AttachReporter.Action) {
        switch action {
        case .none:
            return
        case .print(let line):
            emit(line)
        case .printAndExit(let line, let status):
            emit(line)
            terminate(status)
        }
    }
}
