import Foundation
import UIKit
import WebKit
import os

/// Routes incoming `cdp.request` / `tab.open` messages from the leader to the
/// appropriate CDPTarget (or domain handler) and forwards `cdp.response` /
/// `cdp.event` / `tab.opened` / `targets.advertise` back over the data channel.
///
/// Each "tab" is a WKWebView held in a hidden host view. WKWebView native APIs
/// cover the bulk of the CDP surface; for the rest we inject JavaScript or
/// return a structured `notImplemented` error so the leader's agent can find a
/// workaround.
@MainActor
final class CDPBridge {

    // MARK: - Logging

    private let logger = Logger(subsystem: "com.slicc.follower", category: "CDPBridge")

    // MARK: - Identity

    /// Stable runtime id for this follower instance. Sent in `targets.advertise`.
    let runtimeId: String

    // MARK: - Outgoing

    /// Send a follower→leader message. Provided by AppState.
    private let send: (FollowerToLeaderMessage) -> Void

    // MARK: - Targets

    private var targets: [String: CDPTarget] = [:]
    /// Hidden host view to keep WKWebViews in the view hierarchy. We size it
    /// to be off-screen and isUserInteractionEnabled = false.
    private weak var hostView: UIView?
    /// Monotonic context-id source for evaluate() calls.
    private var nextContextId: Int = 1
    /// Monotonic suffix for new target ids.
    private var nextTargetSuffix: Int = 1

    // MARK: - Init

    init(runtimeId: String, send: @escaping (FollowerToLeaderMessage) -> Void) {
        self.runtimeId = runtimeId
        self.send = send
    }

    /// Attach to a window so off-screen WKWebViews load reliably.
    func attach(to window: UIWindow) {
        if hostView != nil { return }
        let host = UIView(frame: CGRect(x: -10000, y: -10000, width: 1, height: 1))
        host.isHidden = true
        host.isUserInteractionEnabled = false
        window.addSubview(host)
        hostView = host
    }

    // MARK: - Public lifecycle

    /// Drop all targets (called on disconnect).
    func reset() {
        for target in targets.values {
            target.webView.removeFromSuperview()
            target.webView.stopLoading()
        }
        targets.removeAll()
    }

    /// Send the current set of targets to the leader.
    func advertiseTargets() {
        let advertised = targets.values.map { $0.remoteInfo() }
        send(.targetsAdvertise(targets: advertised, runtimeId: runtimeId))
    }

    // MARK: - Inbound dispatch

    /// Dispatch a `cdp.request` from the leader.
    func handleRequest(
        requestId: String,
        localTargetId: String,
        method: String,
        params: AnyCodable?,
        sessionId: String?
    ) {
        let paramsDict = (params?.value as? [String: Any]) ?? [:]
        // Lookup target if applicable.
        let target = targets[localTargetId]
        // Domain dispatch.
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
            case "Network", "Log", "Performance", "Security":
                // Lightweight no-ops to keep clients happy.
                respond(requestId: requestId, result: [:])
            default:
                respondNotImplemented(requestId: requestId, method: method)
            }
        } catch let CDPError.targetNotFound(method) {
            respondError(requestId: requestId,
                         error: "CDP: target not found for \(method) (id=\(localTargetId))")
        } catch {
            respondError(requestId: requestId, error: error.localizedDescription)
        }
    }

    /// Dispatch a `tab.open` from the leader.
    func handleTabOpen(requestId: String, url: String) {
        let id = mintTargetId()
        let webView = makeWebView()
        let target = CDPTarget(targetId: id, webView: webView, contextId: mintContextId())
        target.bridge = self
        targets[id] = target
        if let host = hostView {
            host.addSubview(webView)
        }
        _ = target.navigate(to: url)
        send(.tabOpened(requestId: requestId, targetId: id))
        advertiseTargets()
    }

    // MARK: - Domain handlers

    private func handleTargetDomain(
        method: String, params: [String: Any], requestId: String
    ) {
        switch method {
        case "Target.createTarget":
            let url = (params["url"] as? String) ?? "about:blank"
            let id = mintTargetId()
            let webView = makeWebView()
            let target = CDPTarget(targetId: id, webView: webView, contextId: mintContextId())
            target.bridge = self
            targets[id] = target
            hostView?.addSubview(webView)
            _ = target.navigate(to: url)
            advertiseTargets()
            respond(requestId: requestId, result: ["targetId": id])

        case "Target.closeTarget":
            guard let targetId = params["targetId"] as? String,
                  let target = targets.removeValue(forKey: targetId) else {
                respond(requestId: requestId, result: ["success": false])
                return
            }
            target.webView.stopLoading()
            target.webView.removeFromSuperview()
            advertiseTargets()
            respond(requestId: requestId, result: ["success": true])

        case "Target.getTargets":
            let infos = targets.values.map { $0.targetInfo() }
            respond(requestId: requestId, result: ["targetInfos": infos])

        case "Target.attachToTarget":
            guard let targetId = params["targetId"] as? String,
                  let target = targets[targetId] else {
                respondError(requestId: requestId, error: "Target not found: \(params["targetId"] ?? "?")")
                return
            }
            let sid = "session-\(targetId)"
            target.sessionId = sid
            emitEvent(method: "Target.attachedToTarget", params: [
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
            // No-op on iOS — there's no concept of "active tab" we can switch.
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
            // No-op (off-screen target).
            respond(requestId: requestId, result: [:])

        case "Page.captureScreenshot":
            let format = (params["format"] as? String) ?? "png"
            let quality = params["quality"] as? Int
            target.captureScreenshot(format: format, quality: quality) { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    switch result {
                    case let .success(data):
                        self.respond(requestId: requestId, result: ["data": data])
                    case let .failure(err):
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
            // We don't currently surface a dialog interface; just acknowledge.
            respond(requestId: requestId, result: [:])

        case "Page.getFrameTree":
            respond(requestId: requestId, result: [
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
            // We support a constrained variant: caller passes "functionDeclaration"
            // and "arguments" with serialized values, no objectId chains.
            let fn = (params["functionDeclaration"] as? String) ?? ""
            let args = (params["arguments"] as? [[String: Any]]) ?? []
            let argExprs = args.map { arg -> String in
                if let v = arg["value"] {
                    if let s = try? JSONSerialization.data(withJSONObject: ["v": v]),
                       let json = String(data: s, encoding: .utf8) {
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
            // Return a minimal document node so callers can chain DOM.querySelector.
            respond(requestId: requestId, result: [
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
            // We can't fully model nodeId↔objectId across CDP without state; return a
            // shim object so the agent can fall through to Runtime.evaluate.
            respond(requestId: requestId, result: [
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
            // Synthesize mouse events via JS (most reliable cross-page approach).
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
            // No-op: viewport size on iOS depends on the host view bounds.
            respond(requestId: requestId, result: [:])
        default:
            respondNotImplemented(requestId: requestId, method: method)
        }
    }

    // MARK: - Outgoing helpers

    /// Send a CDP response. If serialized result exceeds 64KB, it's chunked.
    func respond(requestId: String, result: [String: Any]) {
        let codable = AnyCodable(result)
        // Estimate serialized size for chunk decision.
        let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data()
        if data.count <= 64 * 1024 {
            send(.cdpResponse(requestId: requestId, result: codable, error: nil,
                              chunkData: nil, chunkIndex: nil, totalChunks: nil))
            return
        }
        // Chunk the serialized JSON.
        guard let json = String(data: data, encoding: .utf8) else {
            send(.cdpResponse(requestId: requestId, result: nil,
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
            send(.cdpResponse(requestId: requestId, result: nil, error: nil,
                              chunkData: slice, chunkIndex: idx, totalChunks: total))
            idx += 1
            i = end
        }
    }

    func respondError(requestId: String, error: String) {
        send(.cdpResponse(requestId: requestId, result: nil, error: error,
                          chunkData: nil, chunkIndex: nil, totalChunks: nil))
    }

    func respondNotImplemented(requestId: String, method: String) {
        send(.cdpResponse(
            requestId: requestId, result: nil,
            error: "CDP method not implemented in WKWebView bridge: \(method)",
            chunkData: nil, chunkIndex: nil, totalChunks: nil))
    }

    func emitEvent(method: String, params: [String: Any], sessionId: String?) {
        send(.cdpEvent(method: method, params: AnyCodable(params), sessionId: sessionId))
    }

    // MARK: - Internal helpers

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
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
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
