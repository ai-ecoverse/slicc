import AppKit
import Darwin
import Foundation




enum ComputerFollowCLIRunner {
    static func run(_ request: ComputerFollowCLI.Request) -> Int32 {
        switch request {
        case .preflight(let json):
            return runPreflight(json: json)
        case .follow(let joinUrl, let pairId):
            return runFollow(joinUrl: joinUrl, pairId: pairId)
        }
    }

    
    
    
    
    
    
    
    
    
    
    private static func runPreflight(json: Bool) -> Int32 {
        NSApplication.shared.setActivationPolicy(.accessory)
        return ComputerFollowCLI.preflight(
            using: .live, json: json,
            writeOut: { try? FileHandle.standardOutput.write(contentsOf: $0) },
            writeErr: { try? FileHandle.standardError.write(contentsOf: $0) })
    }

    
    
    
    
    
    private static func runFollow(joinUrl: String, pairId: String?) -> Int32 {
        let app = NSApplication.shared
        
        
        
        app.setActivationPolicy(.accessory)

        let session = MainActor.assumeIsolated {
            let session = HeadlessComputerFollow(
                follower: ComputerTrayFollower(pairId: pairId),
                emit: { line in
                    print(line)
                    fflush(stdout)
                },
                terminate: { status in exit(status) })
            session.start(joinUrl: joinUrl)
            return session
        }

        installTerminationHandlers(session)
        watchParent(session)

        app.run()
        return 0
    }

    
    
    
    private static func installTerminationHandlers(_ session: HeadlessComputerFollow) {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { session.signalled() } }
            source.resume()
            
            
            signalSources.append(source)
        }
    }

    
    
    
    
    private static func watchParent(_ session: HeadlessComputerFollow) {
        let parent = getppid()
        
        
        guard !ComputerFollowCLI.parentIsGone(parentPid: parent) else {
            MainActor.assumeIsolated { session.parentExited() }
            return
        }
        let source = DispatchSource.makeProcessSource(
            identifier: parent, eventMask: .exit, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { session.parentExited() } }
        source.resume()
        parentSource = source
        
        
        if ComputerFollowCLI.parentIsGone(parentPid: getppid()) {
            MainActor.assumeIsolated { session.parentExited() }
        }
    }
}


private nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
private nonisolated(unsafe) var parentSource: DispatchSourceProcess?
