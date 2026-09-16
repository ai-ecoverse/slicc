import Foundation

let overlayEgressBlockErrorTexts: Set<String> = [
    "net::ERR_ACCESS_DENIED",
    "net::ERR_NETWORK_ACCESS_DENIED",
    "net::ERR_BLOCKED_BY_CLIENT",
    "net::ERR_BLOCKED_BY_ADMINISTRATOR",
]

let overlayStatusMessageEgressBlocked =
    "SLICC is attached to this app, but it blocks embedded panels. Drive it from the SLICC leader window."

func buildElectronOverlayStatusBootstrapScript(bundleSource: String, statusMessage: String) -> String {
    let escaped =
        statusMessage
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")

    let frameGuard = "try{if(window.top!==window.self)return;}catch(e){return;}"
    let inject = "window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\",statusMessage:\"\(escaped)\"});"
    let injectBody =
        "if(document.body){\(inject)}else{document.addEventListener('DOMContentLoaded',function(){\(inject)});}"
    let injectionCall = "(function(){\(frameGuard)\(injectBody)})();"
    return bundleSource + "\n" + injectionCall
}

enum OverlayNetworkSignal: Equatable {

    case trackOverlayRequest(String)

    case egressBlocked

    case ignore
}

extension ElectronOverlayInjector {

    static func isEgressBlockError(_ errorText: String?) -> Bool {
        guard let errorText else { return false }
        return overlayEgressBlockErrorTexts.contains(errorText)
    }

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
