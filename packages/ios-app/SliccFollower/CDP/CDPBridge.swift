import Foundation
import SliccTrayKit
import UIKit
import WebKit
import os

@MainActor
final class CDPBridge {

    private let logger = Logger(subsystem: "com.slicc.follower", category: "CDPBridge")

    let runtimeId: String

    private let send: (FollowerToLeaderMessage) -> Void

    var onTargetsChanged: (() -> Void)?

    var onHandoffDetected: ((_ pageURL: String, _ match: HandoffMatch, _ title: String?) -> Void)?

    private var targets: [String: CDPTarget] = [:]

    private var targetOrder: [String] = []

    private var nextContextId: Int = 1

    private var nextTargetSuffix: Int = 1

    init(runtimeId: String, send: @escaping (FollowerToLeaderMessage) -> Void) {
        self.runtimeId = runtimeId
        self.send = send
    }

    func attach(to window: UIWindow) {}

    func reportHandoff(pageURL: String, match: HandoffMatch, title: String?) {
        logger.info("Handoff \(match.verb.rawValue) advertised by a hosted page")
        onHandoffDetected?(pageURL, match, title)
    }

    func reset() {
        for target in targets.values {
            target.webView.removeFromSuperview()
            target.webView.stopLoading()
        }
        targets.removeAll()
        targetOrder.removeAll()
        notifyTargetsChanged()
    }

    func advertiseTargets() {
        let advertised = orderedTargets().map { $0.remoteInfo() }
        send(.targetsAdvertise(targets: advertised, runtimeId: runtimeId))
    }

    func currentTargets() -> [CDPTargetSummary] {
        orderedTargets().map {
            CDPTargetSummary(id: $0.targetId, title: $0.currentTitle, url: $0.currentURL)
        }
    }

    func webView(for targetId: String) -> WKWebView? {
        targets[targetId]?.webView
    }

    func notifyTargetsChanged() {
        onTargetsChanged?()
    }

    private func orderedTargets() -> [CDPTarget] {
        targetOrder.compactMap { targets[$0] }
    }

    func handleRequest(
        requestId: String,
        localTargetId: String,
        method: String,
        params: AnyCodable?,
        sessionId: String?
    ) {
        let paramsDict = (params?.value as? [String: Any]) ?? [:]
        logger.info("CDP request: \(method) target=\(localTargetId) reqId=\(requestId, privacy: .public)")

        let target = targets[localTargetId]

        do {
            let domain = method.split(separator: ".").first.map(String.init) ?? ""
            switch domain {
            case "Target":
                handleTargetDomain(method: method, params: paramsDict, requestId: requestId)
            case "Page":
                try requireTarget(target, method: method, requestId: requestId, sessionId: sessionId)
                handlePageDomain(target: target!, method: method, params: paramsDict, requestId: requestId)
            case "Runtime":
                try requireTarget(target, method: method, requestId: requestId, sessionId: sessionId)
                handleRuntimeDomain(target: target!, method: method, params: paramsDict, requestId: requestId)
            case "DOM":
                try requireTarget(target, method: method, requestId: requestId, sessionId: sessionId)
                handleDOMDomain(target: target!, method: method, params: paramsDict, requestId: requestId)
            case "Input":
                try requireTarget(target, method: method, requestId: requestId, sessionId: sessionId)
                handleInputDomain(target: target!, method: method, params: paramsDict, requestId: requestId)
            case "Emulation":
                try requireTarget(target, method: method, requestId: requestId, sessionId: sessionId)
                handleEmulationDomain(target: target!, method: method, params: paramsDict, requestId: requestId)
            case "Network":
                handleNetworkDomain(
                    target: target, method: method, params: paramsDict, requestId: requestId)
            case "Log", "Performance", "Security":

                respond(requestId: requestId, result: [:])
            default:
                respondNotImplemented(requestId: requestId, method: method)
            }
        } catch let CDPError.targetNotFound(method) {
            respondError(
                requestId: requestId,
                error: "CDP: target not found for \(method) (id=\(localTargetId))")
        } catch {
            respondError(requestId: requestId, error: error.localizedDescription)
        }
    }

    func openTab(url: String) -> String {
        let id = mintTargetId()
        let webView = makeWebView()
        let target = CDPTarget(targetId: id, webView: webView, contextId: mintContextId())
        target.bridge = self
        targets[id] = target
        targetOrder.append(id)
        _ = target.navigate(to: url)
        advertiseTargets()
        notifyTargetsChanged()
        return id
    }

    func navigate(targetId: String, to url: String) {
        guard let target = targets[targetId] else { return }
        _ = target.navigate(to: url)
        notifyTargetsChanged()
    }

    @discardableResult
    func handleTabOpen(requestId: String, url: String) -> String? {
        guard let parsed = URL(string: url), parsed.scheme != nil else {
            logger.warning("Rejecting tab.open with an unusable URL")
            send(.tabOpenError(requestId: requestId, error: "unusable URL"))
            return nil
        }
        let id = openTab(url: url)
        send(.tabOpened(requestId: requestId, targetId: id))
        return id
    }

    private func handleTargetDomain(
        method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Target.createTarget":
            let url = (params["url"] as? String) ?? "about:blank"
            let id = openTab(url: url)
            respond(requestId: requestId, result: ["targetId": id])

        case "Target.closeTarget":
            guard let targetId = params["targetId"] as? String,
                let target = targets.removeValue(forKey: targetId)
            else {
                respond(requestId: requestId, result: ["success": false])
                return
            }
            targetOrder.removeAll { $0 == targetId }
            target.webView.stopLoading()
            target.webView.removeFromSuperview()
            advertiseTargets()
            notifyTargetsChanged()
            respond(requestId: requestId, result: ["success": true])

        case "Target.getTargets":
            let infos = targets.values.map { $0.targetInfo() }
            respond(requestId: requestId, result: ["targetInfos": infos])

        case "Target.attachToTarget":
            guard let targetId = params["targetId"] as? String,
                let target = targets[targetId]
            else {
                respondError(requestId: requestId, error: "Target not found: \(params["targetId"] ?? "?")")
                return
            }
            let sid = "session-\(targetId)"
            target.sessionId = sid
            emitEvent(
                method: "Target.attachedToTarget",
                params: [
                    "sessionId": sid,
                    "targetInfo": target.targetInfo(),
                    "waitingForDebugger": false,
                ], sessionId: nil)
            respond(requestId: requestId, result: ["sessionId": sid])

        case "Target.detachFromTarget":
            if let targetId = params["targetId"] as? String, let target = targets[targetId] {
                target.sessionId = nil
            } else if let sid = params["sessionId"] as? String {
                if let target = targets.values.first(where: { $0.sessionId == sid }) {
                    target.sessionId = nil
                }
            }
            respond(requestId: requestId, result: [:])

        case "Target.setDiscoverTargets",
            "Target.setAutoAttach",
            "Target.setDiscoverTargetsFilter":
            respond(requestId: requestId, result: [:])

        case "Target.activateTarget":

            respond(requestId: requestId, result: [:])

        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handlePageDomain(
        target: CDPTarget, method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Page.enable":
            target.pageEnabled = true
            respond(requestId: requestId, result: [:])

        case "Page.disable":
            target.pageEnabled = false
            respond(requestId: requestId, result: [:])

        case "Page.navigate":
            let url = (params["url"] as? String) ?? "about:blank"
            let result = target.navigate(to: url)
            respond(requestId: requestId, result: result)

        case "Page.reload":
            target.reload()
            respond(requestId: requestId, result: [:])

        case "Page.bringToFront":

            respond(requestId: requestId, result: [:])

        case "Page.captureScreenshot":
            let format = (params["format"] as? String) ?? "png"
            let quality = params["quality"] as? Int
            target.captureScreenshot(format: format, quality: quality) { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    switch result {
                    case .success(let data):
                        self.respond(requestId: requestId, result: ["data": data])
                    case .failure(let err):
                        self.respondError(requestId: requestId, error: err.localizedDescription)
                    }
                }
            }

        case "Page.addScriptToEvaluateOnNewDocument":
            let source = (params["source"] as? String) ?? ""
            let id = target.addScriptToEvaluateOnNewDocument(source)
            respond(requestId: requestId, result: ["identifier": id])

        case "Page.removeScriptToEvaluateOnNewDocument":
            let identifier = (params["identifier"] as? String) ?? ""
            target.removeScriptToEvaluateOnNewDocument(identifier)
            respond(requestId: requestId, result: [:])

        case "Page.handleJavaScriptDialog":

            respond(requestId: requestId, result: [:])

        case "Page.getFrameTree":
            respond(
                requestId: requestId,
                result: [
                    "frameTree": [
                        "frame": [
                            "id": target.frameId,
                            "loaderId": "loader-\(target.targetId)-1",
                            "url": target.currentURL,
                            "securityOrigin": "",
                            "mimeType": "text/html",
                        ]
                    ]
                ])

        case "Page.setLifecycleEventsEnabled":
            respond(requestId: requestId, result: [:])

        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handleRuntimeDomain(
        target: CDPTarget, method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Runtime.enable":
            target.runtimeEnabled = true
            respond(requestId: requestId, result: [:])

        case "Runtime.disable":
            target.runtimeEnabled = false
            respond(requestId: requestId, result: [:])

        case "Runtime.evaluate":
            let expression = (params["expression"] as? String) ?? ""
            let awaitPromise = (params["awaitPromise"] as? Bool) ?? false
            let returnByValue = (params["returnByValue"] as? Bool) ?? false
            target.runtimeEvaluate(
                expression: expression,
                awaitPromise: awaitPromise,
                returnByValue: returnByValue
            ) { [weak self] result in
                Task { @MainActor in
                    self?.respond(requestId: requestId, result: result)
                }
            }

        case "Runtime.callFunctionOn":

            let fn = (params["functionDeclaration"] as? String) ?? ""
            let args = (params["arguments"] as? [[String: Any]]) ?? []
            let argExprs = args.map { arg -> String in
                if let v = arg["value"] {
                    if let s = try? JSONSerialization.data(withJSONObject: ["v": v]),
                        let json = String(data: s, encoding: .utf8)
                    {
                        return "(\(json)).v"
                    }
                }
                return "undefined"
            }
            let expr = "(\(fn))(\(argExprs.joined(separator: ",")))"
            let awaitPromise = (params["awaitPromise"] as? Bool) ?? true
            target.runtimeEvaluate(
                expression: expr,
                awaitPromise: awaitPromise,
                returnByValue: (params["returnByValue"] as? Bool) ?? true
            ) { [weak self] result in
                Task { @MainActor in
                    self?.respond(requestId: requestId, result: result)
                }
            }

        case "Runtime.releaseObject", "Runtime.releaseObjectGroup":
            respond(requestId: requestId, result: [:])

        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handleDOMDomain(
        target: CDPTarget, method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "DOM.enable":
            target.domEnabled = true
            respond(requestId: requestId, result: [:])
        case "DOM.disable":
            target.domEnabled = false
            respond(requestId: requestId, result: [:])
        case "DOM.getDocument":

            respond(
                requestId: requestId,
                result: [
                    "root": [
                        "nodeId": 1, "backendNodeId": 1, "nodeType": 9,
                        "nodeName": "#document", "localName": "", "nodeValue": "",
                        "documentURL": target.currentURL,
                        "baseURL": target.currentURL, "xmlVersion": "",
                    ]
                ])
        case "DOM.querySelector":
            let selector = (params["selector"] as? String) ?? ""
            let escaped = selector.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            target.runtimeEvaluate(
                expression: "(function(){var el=document.querySelector('\(escaped)');return el?1:0;})()",
                awaitPromise: false, returnByValue: true
            ) { [weak self] result in
                Task { @MainActor in
                    let value = ((result["result"] as? [String: Any])?["value"] as? Int) ?? 0
                    self?.respond(requestId: requestId, result: ["nodeId": value])
                }
            }
        case "DOM.resolveNode":

            respond(
                requestId: requestId,
                result: [
                    "object": ["type": "object", "objectId": "shim-\(target.targetId)"]
                ])
        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handleInputDomain(
        target: CDPTarget, method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Input.dispatchMouseEvent":
            let type = (params["type"] as? String) ?? ""
            let x = (params["x"] as? Double) ?? 0
            let y = (params["y"] as? Double) ?? 0

            let evt: String
            switch type {
            case "mousePressed": evt = "mousedown"
            case "mouseReleased": evt = "mouseup"
            case "mouseMoved": evt = "mousemove"
            default: evt = type
            }
            let js = """
                (function() {
                  var el = document.elementFromPoint(\(x), \(y));
                  if (!el) return false;
                  var ev = new MouseEvent('\(evt)', {bubbles:true, cancelable:true, clientX:\(x), clientY:\(y), button:0});
                  el.dispatchEvent(ev);
                  if ('\(evt)' === 'mouseup') {
                    var clickEv = new MouseEvent('click', {bubbles:true, cancelable:true, clientX:\(x), clientY:\(y), button:0});
                    el.dispatchEvent(clickEv);
                  }
                  return true;
                })()
                """
            target.runtimeEvaluate(
                expression: js, awaitPromise: false, returnByValue: true
            ) { [weak self] _ in
                Task { @MainActor in self?.respond(requestId: requestId, result: [:]) }
            }
        case "Input.dispatchKeyEvent":
            let type = (params["type"] as? String) ?? ""
            let key = (params["key"] as? String) ?? ""
            let text = (params["text"] as? String) ?? key
            let evt: String
            switch type {
            case "keyDown", "rawKeyDown": evt = "keydown"
            case "keyUp": evt = "keyup"
            case "char": evt = "input"
            default: evt = type
            }
            let escapedKey = key.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let escapedText = text.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js: String
            if evt == "input" {
                js = """
                    (function() {
                      var el = document.activeElement;
                      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
                        if (el.value !== undefined) { el.value += '\(escapedText)'; }
                        else { el.textContent += '\(escapedText)'; }
                        el.dispatchEvent(new Event('input', {bubbles:true}));
                        el.dispatchEvent(new Event('change', {bubbles:true}));
                        return true;
                      }
                      return false;
                    })()
                    """
            } else {
                js = """
                    (function() {
                      var el = document.activeElement || document.body;
                      var ev = new KeyboardEvent('\(evt)', {bubbles:true, cancelable:true, key:'\(escapedKey)'});
                      el.dispatchEvent(ev);
                      return true;
                    })()
                    """
            }
            target.runtimeEvaluate(
                expression: js, awaitPromise: false, returnByValue: true
            ) { [weak self] _ in
                Task { @MainActor in self?.respond(requestId: requestId, result: [:]) }
            }
        case "Input.insertText":
            let text = (params["text"] as? String) ?? ""
            let escaped = text.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = """
                (function() {
                  var el = document.activeElement;
                  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
                    if (el.value !== undefined) { el.value += '\(escaped)'; }
                    else { el.textContent += '\(escaped)'; }
                    el.dispatchEvent(new Event('input', {bubbles:true}));
                    el.dispatchEvent(new Event('change', {bubbles:true}));
                    return true;
                  }
                  return false;
                })()
                """
            target.runtimeEvaluate(
                expression: js, awaitPromise: false, returnByValue: true
            ) { [weak self] _ in
                Task { @MainActor in self?.respond(requestId: requestId, result: [:]) }
            }
        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handleEmulationDomain(
        target: CDPTarget, method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Emulation.setUserAgentOverride":
            let ua = (params["userAgent"] as? String) ?? ""
            target.webView.customUserAgent = ua.isEmpty ? nil : ua
            respond(requestId: requestId, result: [:])
        case "Emulation.setDeviceMetricsOverride",
            "Emulation.clearDeviceMetricsOverride":

            respond(requestId: requestId, result: [:])
        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    private func handleNetworkDomain(
        target: CDPTarget?, method: String, params: [String: Any], requestId: String
    ) {
        let store = WKWebsiteDataStore.default().httpCookieStore
        switch method {
        case "Network.enable", "Network.disable":
            respond(requestId: requestId, result: [:])
        case "Network.getCookies", "Network.getAllCookies":

            var urls = (params["urls"] as? [String]) ?? []
            if urls.isEmpty, let current = target?.currentURL, URL(string: current)?.host != nil {
                urls = [current]
            }
            store.getAllCookies { cookies in
                let scoped =
                    method == "Network.getCookies"
                    ? CDPNetworkDomain.filter(cookies, urls: urls) : cookies
                self.respond(
                    requestId: requestId,
                    result: ["cookies": scoped.map(CDPNetworkDomain.encode)])
            }
        case "Network.setCookie", "Network.setCookies":
            let raw =
                method == "Network.setCookie"
                ? [params] : ((params["cookies"] as? [[String: Any]]) ?? [])
            let cookies = raw.compactMap(CDPNetworkDomain.decode)
            let unmappable = raw.count - cookies.count
            if unmappable > 0 {
                logger.warning("Network.setCookies: \(unmappable) cookie(s) could not be mapped")
            }

            let downgraded = raw.filter { ($0["httpOnly"] as? Bool) == true }.count
            if downgraded > 0 {
                logger.warning(
                    "Network.setCookies: \(downgraded) HttpOnly cookie(s) recreated without the flag")
            }
            guard !cookies.isEmpty else {
                respond(requestId: requestId, result: ["success": raw.isEmpty])
                return
            }

            let group = DispatchGroup()
            for cookie in cookies {
                group.enter()
                store.setCookie(cookie) { group.leave() }
            }
            group.notify(queue: .main) {
                self.respond(requestId: requestId, result: ["success": true])
            }
        case "Network.deleteCookies":

            guard let name = params["name"] as? String, !name.isEmpty else {
                respondError(requestId: requestId, error: "Network.deleteCookies requires `name`")
                return
            }
            let scopeURL = (params["url"] as? String).flatMap { URL(string: $0) }
            let domain = (params["domain"] as? String) ?? scopeURL?.host
            let explicitPath = params["path"] as? String
            let path = explicitPath ?? scopeURL?.path
            store.getAllCookies { cookies in
                let doomed = cookies.filter {
                    CDPNetworkDomain.matchesDeletion(
                        $0, name: name, domain: domain, path: path,
                        pathIsExact: explicitPath != nil)
                }
                let group = DispatchGroup()
                for cookie in doomed {
                    group.enter()
                    store.delete(cookie) { group.leave() }
                }
                group.notify(queue: .main) {
                    self.respond(requestId: requestId, result: [:])
                }
            }
        case "Network.clearBrowserCookies":
            store.getAllCookies { cookies in
                let group = DispatchGroup()
                for cookie in cookies {
                    group.enter()
                    store.delete(cookie) { group.leave() }
                }
                group.notify(queue: .main) {
                    self.respond(requestId: requestId, result: [:])
                }
            }
        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    func respond(requestId: String, result: [String: Any]) {
        let codable = AnyCodable(result)

        let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data()
        if data.count <= 64 * 1024 {
            send(
                .cdpResponse(
                    requestId: requestId, result: codable, error: nil,
                    chunkData: nil, chunkIndex: nil, totalChunks: nil))
            return
        }

        guard let json = String(data: data, encoding: .utf8) else {
            send(
                .cdpResponse(
                    requestId: requestId, result: nil,
                    error: "Result not utf-8 serializable",
                    chunkData: nil, chunkIndex: nil, totalChunks: nil))
            return
        }
        let chunkSize = 32 * 1024
        let total = Int(ceil(Double(json.count) / Double(chunkSize)))
        var idx = 0
        var i = json.startIndex
        while i < json.endIndex {
            let end = json.index(i, offsetBy: chunkSize, limitedBy: json.endIndex) ?? json.endIndex
            let slice = String(json[i..<end])
            send(
                .cdpResponse(
                    requestId: requestId, result: nil, error: nil,
                    chunkData: slice, chunkIndex: idx, totalChunks: total))
            idx += 1
            i = end
        }
    }

    func respondError(requestId: String, error: String) {
        send(
            .cdpResponse(
                requestId: requestId, result: nil, error: error,
                chunkData: nil, chunkIndex: nil, totalChunks: nil))
    }

    func respondNotImplemented(requestId: String, method: String) {
        send(
            .cdpResponse(
                requestId: requestId, result: nil,
                error: "CDP method not implemented in WKWebView bridge: \(method)",
                chunkData: nil, chunkIndex: nil, totalChunks: nil))
    }

    func emitEvent(method: String, params: [String: Any], sessionId: String?) {
        send(.cdpEvent(method: method, params: AnyCodable(params), sessionId: sessionId))
    }

    private func mintTargetId() -> String {
        let id = "wk-\(runtimeId)-\(nextTargetSuffix)"
        nextTargetSuffix += 1
        return id
    }

    private func mintContextId() -> Int {
        let id = nextContextId
        nextContextId += 1
        return id
    }

    private func makeWebView() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let webView = WKWebView(frame: frame, configuration: cfg)
        webView.isInspectable = true
        return webView
    }

    private func requireTarget(
        _ target: CDPTarget?, method: String, requestId: String, sessionId: String?
    ) throws {
        if target == nil {
            throw CDPError.targetNotFound(method)
        }
    }

    private enum CDPError: Error {
        case targetNotFound(String)
    }
}
