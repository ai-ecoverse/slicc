import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LeaderJoinUrl")








extension SliccProcess {

    
    
    
    static let leaderJoinUrlWatchInterval: TimeInterval = 60

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    @discardableResult
    func refreshLeaderJoinUrl(
        maxAttempts: Int = 1,
        retryDelay: TimeInterval = 1.5
    ) async -> String? {
        
        
        
        
        
        
        
        
        
        
        guard let servePort = await MainActor.run(body: { [weak self] in self?.leaderServePort })
        else { return nil }
        let joinUrl = await trayStatusProbe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:\(servePort)",
            maxAttempts: maxAttempts,
            retryDelay: retryDelay,
            exhaustion: .retryable
        )
        guard let joinUrl, !joinUrl.isEmpty else { return nil }
        return await MainActor.run { [weak self] () -> String? in
            
            guard let self, self.leaderServePort != nil else {
                log.info("refreshLeaderJoinUrl: discarding join URL — browser already gone")
                return nil
            }
            if self.leaderJoinUrl != joinUrl {
                log.info("refreshLeaderJoinUrl: tray re-minted — adopting the new join URL")
                self.leaderJoinUrl = joinUrl
            }
            return joinUrl
        }
    }

    
    
    
    
    
    func startLeaderJoinUrlWatch(
        interval: TimeInterval = SliccProcess.leaderJoinUrlWatchInterval
    ) {
        leaderJoinUrlWatchTask?.cancel()
        leaderJoinUrlWatchTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                
                
                
                let state: LeaderWatchState = await MainActor.run { [weak self] in
                    guard let self else { return .ownerGone }
                    return self.leaderServePort == nil ? .idle : .hasLeader
                }
                switch state {
                case .ownerGone: return
                case .idle: continue
                case .hasLeader: await self?.refreshLeaderJoinUrl()
                }
            }
        }
    }

    private enum LeaderWatchState {
        case hasLeader
        case idle
        case ownerGone
    }

    
    
    
    func stopLeaderJoinUrlWatch() {
        leaderJoinUrlWatchTask?.cancel()
        leaderJoinUrlWatchTask = nil
    }

}
