import Foundation








extension AppState {

    
    
    
    
    
    
    var rawConnectionHealth: ConnectionHealth {
        ConnectionHealth(
            state: connectionState,
            isStalled: isLeaderStalled,
            reconnectAttempt: connectionState == .reconnecting ? reconnectAttempt : 0)
    }

    
    
    func ingestConnectionHealth() {
        guard !connectionIngestSuspended else { return }
        connectionSettler.ingest(rawConnectionHealth)
    }

    
    
    
    
    
    
    
    
    
    func updateConnection(_ mutate: () -> Void) {
        connectionIngestSuspended = true
        mutate()
        connectionIngestSuspended = false
        ingestConnectionHealth()
    }

    #if DEBUG
        
        
        
        
        
        func settleConnectionImmediately() {
            connectionSettler.settleImmediately(rawConnectionHealth)
        }
    #endif
}
