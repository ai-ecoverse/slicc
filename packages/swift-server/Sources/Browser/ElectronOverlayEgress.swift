import Foundation

// Egress-block detection for the Electron overlay injector. Signal (and other
// locked-down Electron apps) proxy all renderer network through their main
// process and deny external requests with `net::ERR_ACCESS_DENIED`, BENEATH the
// layer where `Page.setBypassCSP` or the CDP Fetch proxy operate — so the hosted
// overlay iframe can never load and the reload/Fetch escalation cannot help.
// This is detected authoritatively from the failed document request (the thrown
// overlay-loaded probe can't tell an egress block from a real cross-origin load,
// since both throw). Mirrors node-server's `electron-controller.ts` helpers.

/// CDP `Network.loadingFailed` `errorText` values that mean the *app itself*
/// denied the overlay's document request at the network layer — not a CSP block.
/// Mirrors node-server's `OVERLAY_EGRESS_BLOCK_ERROR_TEXTS`.
let overlayEgressBlockErrorTexts: Set<String> = [
    "net::ERR_ACCESS_DENIED",
    "net::ERR_NETWORK_ACCESS_DENIED",
    "net::ERR_BLOCKED_BY_CLIENT",
    "net::ERR_BLOCKED_BY_ADMINISTRATOR",
]

/// Outcome of inspecting one `Network.*` CDP event for the egress-block signal.
enum OverlayNetworkSignal: Equatable {
    /// A `Network.requestWillBeSent` for OUR overlay iframe's document —
    /// remember its `requestId` so a later `loadingFailed` can be correlated.
    case trackOverlayRequest(String)
    /// A `Network.loadingFailed` on a tracked overlay request with an
    /// app-layer denial — the target blocks renderer egress.
    case egressBlocked
    /// Not relevant to egress detection.
    case ignore
}

extension ElectronOverlayInjector {
    /// True when `errorText` is one of `overlayEgressBlockErrorTexts`. Mirrors
    /// node-server's `isOverlayEgressBlockError`.
    static func isEgressBlockError(_ errorText: String?) -> Bool {
        guard let errorText else { return false }
        return overlayEgressBlockErrorTexts.contains(errorText)
    }

    /// Classify a `Network.*` CDP event for the egress-block signal (pure).
    /// Tracks OUR overlay iframe's top-level Document request — matched by the
    /// per-process bridge token in its URL so the app's own frames are ignored —
    /// and flags a network-layer denial on a tracked request. Mirrors
    /// node-server's `handleNetworkEventForEgressBlock` correlation logic.
    static func classifyNetworkEvent(
        method: String,
        params: [String: Any]?,
        bridgeToken: String,
        overlayRequestIDs: Set<String>
    ) -> OverlayNetworkSignal {
        guard let params else { return .ignore }
        switch method {
        case "Network.requestWillBeSent":
            if (params["type"] as? String) == "Document",
                let requestId = params["requestId"] as? String,
                let request = params["request"] as? [String: Any],
                let url = request["url"] as? String,
                url.contains(bridgeToken)
            {
                return .trackOverlayRequest(requestId)
            }
            return .ignore
        case "Network.loadingFailed":
            if let requestId = params["requestId"] as? String,
                overlayRequestIDs.contains(requestId),
                isEgressBlockError(params["errorText"] as? String)
            {
                return .egressBlocked
            }
            return .ignore
        default:
            return .ignore
        }
    }
}
