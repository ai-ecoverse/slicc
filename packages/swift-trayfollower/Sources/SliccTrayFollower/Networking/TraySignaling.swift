import Foundation

// MARK: - Errors

enum TraySignalingError: Error, LocalizedError {
    case invalidResponse(statusCode: Int, body: String)
    case invalidAttachResponse(statusCode: Int, body: String)
    case invalidBootstrapResponse(statusCode: Int, body: String)
    case networkError(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse(let code, let body):
            return "Tray signaling returned invalid response (\(code)): \(body.prefix(200))"
        case .invalidAttachResponse(let code, let body):
            return "Tray follower attach returned invalid response (\(code)): \(body.prefix(200))"
        case .invalidBootstrapResponse(let code, let body):
            return "Tray follower bootstrap returned invalid response (\(code)): \(body.prefix(200))"
        case .networkError(let underlying):
            return "Tray signaling network error: \(underlying.localizedDescription)"
        }
    }
}

// Wire types are defined in SliccTrayKit/Models/TrayTypes.swift

// MARK: - Raw HTTP response shapes (private, for decoding only)

/// Mirrors FollowerAttachResponse from @slicc/shared-ts tray-signaling.ts
private struct RawFollowerAttachResponse: Codable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let result: AttachResult
    let iceServers: [TurnIceServer]?

    struct AttachResult: Codable {
        let action: String
        let code: String
        let retryAfterMs: Int?
        let error: String?
        let bootstrap: TrayBootstrapStatus?
        /// Only present on `TRAY_SUPERSEDED` — the replacement tray to attach to.
        let joinUrl: String?
    }
}

/// Mirrors FollowerBootstrapResponse from @slicc/shared-ts tray-signaling.ts
private struct RawFollowerBootstrapResponse: Codable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let bootstrap: TrayBootstrapStatus
    let events: [TrayBootstrapEvent]
    let iceServers: [TurnIceServer]?
}

// MARK: - Plan types (public API)

public enum AttachAction: String, Sendable {
    case wait, signal, fail
}

public struct FollowerAttachPlan: Sendable {
    public let trayId: String
    public let controllerId: String
    public let participantCount: Int
    public let leader: TrayLeaderSummary?
    public let action: AttachAction
    public let code: String
    public var retryAfterMs: Int?
    public var error: String?
    public var bootstrap: TrayBootstrapStatus?
    public var iceServers: [TurnIceServer]?
    /// Set when `code == "TRAY_SUPERSEDED"` — the join URL to attach to instead.
    public var supersededByJoinUrl: String?
}

public struct FollowerBootstrapPlan: Sendable {
    public let trayId: String
    public let controllerId: String
    public let participantCount: Int
    public let leader: TrayLeaderSummary?
    public let bootstrap: TrayBootstrapStatus
    public let events: [TrayBootstrapEvent]
}

// MARK: - Signaling Client

public actor TraySignalingClient {
    /// Seam over `URLSession.data(for:)` so the attach/bootstrap state machines
    /// can be exercised without a live tray hub.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public let joinUrl: URL
    private let transport: Transport

    /// A session that reports the hub's supersede 308 instead of following it
    /// (#1957). `SupersedeRedirect` owns the five-hop bound and the consumer
    /// persists the replacement (`activeJoinUrl` on iOS) so a later reconnect
    /// dials the live tray; a silently-followed redirect would connect once and
    /// leave the stored address dead. Shared across clients — the delegate is
    /// stateless, and `URLSession` retains it for the process lifetime either
    /// way.
    private static let redirectSuppressingSession = URLSession(
        configuration: .default, delegate: NoRedirectDelegate(), delegateQueue: nil)

    /// `session: nil` takes the redirect-suppressing default above. A caller
    /// that supplies its own is responsible for suppressing redirects itself,
    /// or it will silently lose the supersede hop.
    public init(joinUrl: URL, session: URLSession? = nil) {
        let session = session ?? Self.redirectSuppressingSession
        self.init(joinUrl: joinUrl) { try await session.data(for: $0) }
    }

    public init(joinUrl: URL, transport: @escaping Transport) {
        self.joinUrl = joinUrl
        self.transport = transport
    }

    // MARK: - 1. Attach

    /// First call to join a tray. POST { controllerId, runtime } → FollowerAttachPlan
    public func attach(controllerId: String, runtime: String = "slicc-ios") async throws -> FollowerAttachPlan {
        let body: [String: Any] = ["controllerId": controllerId, "runtime": runtime]
        let (data, response) = try await post(body: body)
        let rawText = String(data: data, encoding: .utf8) ?? "(empty)"

        // #1957: a superseded tray states the replacement three times — in the
        // body, as an RFC 5829 `successor-version` link, and as the 308's
        // `Location`. The link is preferred (it is the canonical join URL;
        // `Location` carries the hub's `json=true`), and any one of them alone
        // is enough to follow the hop, so an unreadable or unrecognized body is
        // no longer a dead end (that was #1956).
        let successor =
            (SupersedeLink.successor(in: response)
            ?? SupersedeLink.redirectTarget(in: response))?.absoluteString

        guard let raw = try? JSONDecoder().decode(RawFollowerAttachResponse.self, from: data) else {
            if let successor {
                return Self.supersededPlan(controllerId: controllerId, joinUrl: successor)
            }
            throw TraySignalingError.invalidAttachResponse(
                statusCode: response.statusCode, body: rawText)
        }
        do {
            try validateAttachResponse(raw, statusCode: response.statusCode, rawText: rawText)
        } catch {
            guard let successor else { throw error }
            return Self.supersededPlan(controllerId: controllerId, joinUrl: successor)
        }
        return normalizeAttachResponse(raw, successorFromLink: successor)
    }

    /// The plan for a redirect the hub named in the header alone — the body
    /// told us nothing this build could use.
    private static func supersededPlan(controllerId: String, joinUrl: String) -> FollowerAttachPlan {
        FollowerAttachPlan(
            trayId: "",
            controllerId: controllerId,
            participantCount: 0,
            leader: nil,
            action: .fail,
            code: "TRAY_SUPERSEDED",
            retryAfterMs: nil,
            error: nil,
            bootstrap: nil,
            iceServers: nil,
            supersededByJoinUrl: joinUrl
        )
    }

    // MARK: - 2. Poll

    /// Poll for bootstrap events (offer, ICE candidates).
    public func pollBootstrap(
        controllerId: String, bootstrapId: String, cursor: Int?
    ) async throws -> FollowerBootstrapPlan {
        var body: [String: Any] = [
            "action": "poll",
            "controllerId": controllerId,
            "bootstrapId": bootstrapId,
        ]
        if let cursor { body["cursor"] = cursor }
        return try await postBootstrapRequest(body: body)
    }

    // MARK: - 3. Answer

    /// Send SDP answer back to the leader.
    public func sendAnswer(
        controllerId: String, bootstrapId: String, answer: TraySessionDescription
    ) async throws -> FollowerBootstrapPlan {
        let body: [String: Any] = [
            "action": "answer",
            "controllerId": controllerId,
            "bootstrapId": bootstrapId,
            "answer": ["type": answer.type.rawValue, "sdp": answer.sdp],
        ]
        return try await postBootstrapRequest(body: body)
    }

    // MARK: - 4. ICE Candidate

    /// Send an ICE candidate to the leader.
    public func sendIceCandidate(
        controllerId: String, bootstrapId: String, candidate: TrayIceCandidate
    ) async throws -> FollowerBootstrapPlan {
        var candidateDict: [String: Any] = ["candidate": candidate.candidate]
        if let sdpMid = candidate.sdpMid { candidateDict["sdpMid"] = sdpMid }
        if let sdpMLineIndex = candidate.sdpMLineIndex { candidateDict["sdpMLineIndex"] = sdpMLineIndex }
        if let usernameFragment = candidate.usernameFragment { candidateDict["usernameFragment"] = usernameFragment }

        let body: [String: Any] = [
            "action": "ice-candidate",
            "controllerId": controllerId,
            "bootstrapId": bootstrapId,
            "candidate": candidateDict,
        ]
        return try await postBootstrapRequest(body: body)
    }

    // MARK: - 5. Retry

    /// Retry a failed bootstrap.
    public func retryBootstrap(
        controllerId: String, bootstrapId: String, runtime: String = "slicc-ios"
    ) async throws -> FollowerBootstrapPlan {
        let body: [String: Any] = [
            "action": "retry",
            "controllerId": controllerId,
            "bootstrapId": bootstrapId,
            "runtime": runtime,
        ]
        return try await postBootstrapRequest(body: body)
    }

    // MARK: - Private helpers

    private func post(body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: joinUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, urlResponse): (Data, URLResponse)
        do {
            (data, urlResponse) = try await transport(request)
        } catch {
            throw TraySignalingError.networkError(underlying: error)
        }

        guard let httpResponse = urlResponse as? HTTPURLResponse else {
            throw TraySignalingError.invalidResponse(statusCode: 0, body: "(not HTTP)")
        }
        return (data, httpResponse)
    }

    private func postBootstrapRequest(body: [String: Any]) async throws -> FollowerBootstrapPlan {
        let (data, response) = try await post(body: body)
        let rawText = String(data: data, encoding: .utf8) ?? "(empty)"

        guard let raw = try? JSONDecoder().decode(RawFollowerBootstrapResponse.self, from: data),
            raw.role == "follower"
        else {
            throw TraySignalingError.invalidBootstrapResponse(
                statusCode: response.statusCode, body: rawText)
        }

        return FollowerBootstrapPlan(
            trayId: raw.trayId,
            controllerId: raw.controllerId,
            participantCount: raw.participantCount,
            leader: raw.leader,
            bootstrap: raw.bootstrap,
            events: raw.events
        )
    }

    /// Validates the attach response shape, matching `isFollowerAttachResponse` in tray-follower.ts.
    private func validateAttachResponse(_ raw: RawFollowerAttachResponse, statusCode: Int, rawText: String) throws {
        guard raw.role == "follower" else {
            throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
        }
        let r = raw.result
        switch r.action {
        case "wait":
            guard r.code == "LEADER_NOT_ELECTED" || r.code == "LEADER_NOT_CONNECTED",
                r.retryAfterMs != nil
            else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        case "signal":
            guard r.code == "LEADER_CONNECTED", r.bootstrap != nil else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        case "redirect":
            // The 308 supersede shape (#1957). Same requirements as the `fail`
            // spelling below: without a replacement address there is nothing to
            // redirect to, which makes it a malformed reply rather than a hop.
            guard r.code == "TRAY_SUPERSEDED", r.error != nil,
                r.joinUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        case "fail":
            // A superseded tray on a pre-#1957 hub is a redirect dressed as a
            // failure: the leader reconnected into a fresh tray and this one will
            // never come back. Callers follow `joinUrl` (see `SupersedeRedirect`),
            // so the URL is as load-bearing as `error` and its absence is a
            // malformed reply.
            if r.code == "TRAY_SUPERSEDED" {
                let replacement = r.joinUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
                guard r.error != nil, replacement?.isEmpty == false else {
                    throw TraySignalingError.invalidAttachResponse(
                        statusCode: statusCode, body: rawText)
                }
                break
            }
            guard r.code == "INVALID_JOIN_CAPABILITY" || r.code == "TRAY_EXPIRED",
                r.error != nil
            else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        default:
            throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
        }
    }

    /// Converts the raw attach response into the flattened FollowerAttachPlan.
    private func normalizeAttachResponse(
        _ raw: RawFollowerAttachResponse, successorFromLink: String? = nil
    ) -> FollowerAttachPlan {
        // `redirect` has no `AttachAction` case on purpose: it always carries a
        // replacement, so it is normalized into the supersede plan below and the
        // plan keeps the three actions every consumer already switches over —
        // the same collapse `normalizeFollowerAttachResponse` does in TS.
        let action = AttachAction(rawValue: raw.result.action) ?? .fail
        return FollowerAttachPlan(
            trayId: raw.trayId,
            controllerId: raw.controllerId,
            participantCount: raw.participantCount,
            leader: raw.leader,
            action: action,
            code: raw.result.code,
            retryAfterMs: raw.result.retryAfterMs,
            error: raw.result.error,
            bootstrap: raw.result.bootstrap,
            iceServers: raw.iceServers,
            // The link wins over the body — it is the channel that survives a
            // body-shape change — and it rides on every action, not just the
            // `fail` the current contract happens to use.
            supersededByJoinUrl: successorFromLink
                ?? (raw.result.code == "TRAY_SUPERSEDED" ? raw.result.joinUrl : nil)
        )
    }
}
