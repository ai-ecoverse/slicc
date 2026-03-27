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

// Wire types are defined in Models/TrayTypes.swift

// MARK: - Raw HTTP response shapes (private, for decoding only)

/// Mirrors FollowerAttachResponse from tray-types.ts
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
    }
}

/// Mirrors FollowerBootstrapResponse from tray-types.ts
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

enum AttachAction: String, Sendable {
    case wait, signal, fail
}

struct FollowerAttachPlan: Sendable {
    let trayId: String
    let controllerId: String
    let participantCount: Int
    let leader: TrayLeaderSummary?
    let action: AttachAction
    let code: String
    var retryAfterMs: Int?
    var error: String?
    var bootstrap: TrayBootstrapStatus?
    var iceServers: [TurnIceServer]?
}

struct FollowerBootstrapPlan: Sendable {
    let trayId: String
    let controllerId: String
    let participantCount: Int
    let leader: TrayLeaderSummary?
    let bootstrap: TrayBootstrapStatus
    let events: [TrayBootstrapEvent]
}

// MARK: - Signaling Client

actor TraySignalingClient {
    let joinUrl: URL
    private let session: URLSession

    init(joinUrl: URL, session: URLSession = .shared) {
        self.joinUrl = joinUrl
        self.session = session
    }

    // MARK: - 1. Attach

    /// First call to join a tray. POST { controllerId, runtime } → FollowerAttachPlan
    func attach(controllerId: String, runtime: String = "slicc-ios") async throws -> FollowerAttachPlan {
        let body: [String: Any] = ["controllerId": controllerId, "runtime": runtime]
        let (data, response) = try await post(body: body)
        let rawText = String(data: data, encoding: .utf8) ?? "(empty)"

        guard let raw = try? JSONDecoder().decode(RawFollowerAttachResponse.self, from: data) else {
            throw TraySignalingError.invalidAttachResponse(
                statusCode: response.statusCode, body: rawText)
        }
        try validateAttachResponse(raw, statusCode: response.statusCode, rawText: rawText)
        return normalizeAttachResponse(raw)
    }

    // MARK: - 2. Poll

    /// Poll for bootstrap events (offer, ICE candidates).
    func pollBootstrap(controllerId: String, bootstrapId: String, cursor: Int?) async throws -> FollowerBootstrapPlan {
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
    func sendAnswer(controllerId: String, bootstrapId: String, answer: TraySessionDescription) async throws -> FollowerBootstrapPlan {
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
    func sendIceCandidate(controllerId: String, bootstrapId: String, candidate: TrayIceCandidate) async throws -> FollowerBootstrapPlan {
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
    func retryBootstrap(controllerId: String, bootstrapId: String, runtime: String = "slicc-ios") async throws -> FollowerBootstrapPlan {
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
            (data, urlResponse) = try await session.data(for: request)
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
            guard (r.code == "LEADER_NOT_ELECTED" || r.code == "LEADER_NOT_CONNECTED"),
                  r.retryAfterMs != nil else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        case "signal":
            guard r.code == "LEADER_CONNECTED", r.bootstrap != nil else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        case "fail":
            guard (r.code == "INVALID_JOIN_CAPABILITY" || r.code == "TRAY_EXPIRED"),
                  r.error != nil else {
                throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
            }
        default:
            throw TraySignalingError.invalidAttachResponse(statusCode: statusCode, body: rawText)
        }
    }

    /// Converts the raw attach response into the flattened FollowerAttachPlan.
    private func normalizeAttachResponse(_ raw: RawFollowerAttachResponse) -> FollowerAttachPlan {
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
            iceServers: raw.iceServers
        )
    }
}

