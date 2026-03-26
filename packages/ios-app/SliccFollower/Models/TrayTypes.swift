import Foundation

// MARK: - TraySessionDescription

struct TraySessionDescription: Codable {
    let type: SDPType
    let sdp: String

    enum SDPType: String, Codable {
        case offer
        case answer
    }
}

// MARK: - TrayIceCandidate

struct TrayIceCandidate: Codable {
    let candidate: String
    let sdpMid: String?
    let sdpMLineIndex: Int?
    let usernameFragment: String?
}

// MARK: - TrayBootstrapState

enum TrayBootstrapState: String, Codable {
    case pending
    case offered
    case connected
    case failed
}

// MARK: - TrayBootstrapFailure

struct TrayBootstrapFailure: Codable {
    let code: String
    let message: String
    let retryable: Bool
    let retryAfterMs: Int?
    let failedAt: String
}

// MARK: - TrayBootstrapStatus

struct TrayBootstrapStatus: Codable {
    let controllerId: String
    let bootstrapId: String
    let attempt: Int
    let state: TrayBootstrapState
    let expiresAt: String
    let cursor: Int
    let maxRetries: Int
    let retriesRemaining: Int
    let retryAfterMs: Int?
    let failure: TrayBootstrapFailure?
}

// MARK: - TurnIceServer

struct TurnIceServer: Codable {
    let urls: [String]
    let username: String
    let credential: String
}

// MARK: - TrayLeaderSummary

struct TrayLeaderSummary: Codable {
    let controllerId: String
    let connected: Bool
    let reconnectDeadline: String?
}

// MARK: - TrayBootstrapEvent

enum TrayBootstrapEvent: Codable {
    case offer(sequence: Int, sentAt: String, offer: TraySessionDescription)
    case iceCandidate(sequence: Int, sentAt: String, candidate: TrayIceCandidate)
    case failed(sequence: Int, sentAt: String, failure: TrayBootstrapFailure)

    private enum CodingKeys: String, CodingKey {
        case type, sequence, sentAt, offer, candidate, failure
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let sequence = try container.decode(Int.self, forKey: .sequence)
        let sentAt = try container.decode(String.self, forKey: .sentAt)
        switch type {
        case "bootstrap.offer":
            let offer = try container.decode(TraySessionDescription.self, forKey: .offer)
            self = .offer(sequence: sequence, sentAt: sentAt, offer: offer)
        case "bootstrap.ice_candidate":
            let cand = try container.decode(TrayIceCandidate.self, forKey: .candidate)
            self = .iceCandidate(sequence: sequence, sentAt: sentAt, candidate: cand)
        case "bootstrap.failed":
            let fail = try container.decode(TrayBootstrapFailure.self, forKey: .failure)
            self = .failed(sequence: sequence, sentAt: sentAt, failure: fail)
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "Unknown TrayBootstrapEvent type: \(type)"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .offer(seq, sent, offer):
            try container.encode("bootstrap.offer", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(offer, forKey: .offer)
        case let .iceCandidate(seq, sent, cand):
            try container.encode("bootstrap.ice_candidate", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(cand, forKey: .candidate)
        case let .failed(seq, sent, fail):
            try container.encode("bootstrap.failed", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(fail, forKey: .failure)
        }
    }
}

// MARK: - FollowerAttachResult

enum FollowerAttachResult: Codable {
    case wait(code: String, retryAfterMs: Int)
    case signal(code: String, bootstrap: TrayBootstrapStatus)
    case fail(code: String, error: String)

    private enum CodingKeys: String, CodingKey {
        case action, code, retryAfterMs, bootstrap, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let action = try container.decode(String.self, forKey: .action)
        switch action {
        case "wait":
            self = .wait(
                code: try container.decode(String.self, forKey: .code),
                retryAfterMs: try container.decode(Int.self, forKey: .retryAfterMs))
        case "signal":
            self = .signal(
                code: try container.decode(String.self, forKey: .code),
                bootstrap: try container.decode(TrayBootstrapStatus.self, forKey: .bootstrap))
        case "fail":
            self = .fail(
                code: try container.decode(String.self, forKey: .code),
                error: try container.decode(String.self, forKey: .error))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "Unknown action: \(action)"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .wait(code, retryAfterMs):
            try container.encode("wait", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(retryAfterMs, forKey: .retryAfterMs)
        case let .signal(code, bootstrap):
            try container.encode("signal", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(bootstrap, forKey: .bootstrap)
        case let .fail(code, error):
            try container.encode("fail", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(error, forKey: .error)
        }
    }
}

// MARK: - FollowerAttachResponse

struct FollowerAttachResponse: Codable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let result: FollowerAttachResult
    let iceServers: [TurnIceServer]?
}

// MARK: - FollowerBootstrapResponse

struct FollowerBootstrapResponse: Codable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let bootstrap: TrayBootstrapStatus
    let events: [TrayBootstrapEvent]
    let iceServers: [TurnIceServer]?
}
