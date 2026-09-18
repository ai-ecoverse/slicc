import Foundation
import SliccTrayKit
import UIKit







extension AppState {
    
    
    static let computerTrayFps: Double = 2
    static let computerTrayMaxWidth: Double = 480

    #if DEBUG
        var debugComputerOutgoing: [FollowerToLeaderMessage] {
            get { computerRosterStorage.outgoing }
            set { computerRosterStorage.outgoing = newValue }
        }
    #endif

    func handleComputerLeaderMessage(_ message: LeaderToFollowerMessage) {
        switch message {
        case .computersList(let next):
            applyComputerRoster(next)
        case .computerFrame(
            let id, let seq, _, let width, let height, let data, let chunkData,
            let chunkIndex, let totalChunks):
            applyComputerFrame(
                id: id, seq: seq, width: width, height: height, data: data,
                chunkData: chunkData, chunkIndex: chunkIndex, totalChunks: totalChunks)
        case .computerNativeCapture, .computerNativeUnwatch, .computerNativeInput:
            break
        default:
            break
        }
    }

    func liveFrame(forComputerId id: String) -> ComputerLiveFrame {
        if let existing = computerRosterStorage.liveFrames[id] { return existing }
        let frame = ComputerLiveFrame(id: id)
        computerRosterStorage.liveFrames[id] = frame
        return frame
    }

    
    func startWatchingComputer(_ id: String) {
        let n = (computerRosterStorage.watchCounts[id] ?? 0) + 1
        computerRosterStorage.watchCounts[id] = n
        guard n == 1 else { return }
        sendComputerToLeader(
            .computerWatch(
                id: id, fps: Self.computerTrayFps, maxWidth: Self.computerTrayMaxWidth))
    }

    func stopWatchingComputer(_ id: String) {
        let n = (computerRosterStorage.watchCounts[id] ?? 0) - 1
        if n <= 0 {
            computerRosterStorage.watchCounts.removeValue(forKey: id)
            sendComputerToLeader(.computerUnwatch(id: id))
            return
        }
        computerRosterStorage.watchCounts[id] = n
    }

    func sendComputerSoftKey(id: String, keysym: String) {
        sendComputerToLeader(
            .computerInput(id: id, events: [.key(keysym: keysym, down: nil)]))
    }

    func resetComputers() {
        computers = []
        viewingComputerId = nil
        computerRosterStorage.liveFrames.removeAll()
        computerRosterStorage.watchCounts.removeAll()
        computerRosterStorage.assembler.removeAll()
        #if DEBUG
            computerRosterStorage.outgoing.removeAll()
        #endif
    }

    private func applyComputerRoster(_ next: [ComputerDescriptor]) {
        computers = next
        let live = Set(next.map(\.id))
        if let viewing = viewingComputerId, !live.contains(viewing) {
            viewingComputerId = nil
        }
        for id in computerRosterStorage.liveFrames.keys where !live.contains(id) {
            computerRosterStorage.liveFrames.removeValue(forKey: id)
        }
        for id in computerRosterStorage.watchCounts.keys where !live.contains(id) {
            computerRosterStorage.watchCounts.removeValue(forKey: id)
            sendComputerToLeader(.computerUnwatch(id: id))
        }
        replayComputerWatches()
    }

    
    
    
    private func replayComputerWatches() {
        for id in computerRosterStorage.watchCounts.keys {
            sendComputerToLeader(
                .computerWatch(
                    id: id, fps: Self.computerTrayFps, maxWidth: Self.computerTrayMaxWidth))
        }
    }

    private func applyComputerFrame(
        id: String, seq: Int, width: Double, height: Double, data: String?,
        chunkData: String?, chunkIndex: Int?, totalChunks: Int?
    ) {
        guard computers.contains(where: { $0.id == id }) else { return }
        guard
            let b64 = computerRosterStorage.assembler.accept(
                id: id, seq: seq, data: data, chunkData: chunkData, chunkIndex: chunkIndex,
                totalChunks: totalChunks),
            let bytes = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]),
            let image = UIImage(data: bytes)
        else { return }
        liveFrame(forComputerId: id).apply(image: image, seq: seq, width: width, height: height)
    }

    @discardableResult
    private func sendComputerToLeader(_ message: FollowerToLeaderMessage) -> Bool {
        #if DEBUG
            computerRosterStorage.outgoing.append(message)
        #endif
        return sendToLeader(message)
    }
}
