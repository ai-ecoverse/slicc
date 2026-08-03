import Foundation

// Swift mirror of a subset of the canonical tray signaling wire contract in
// `packages/shared-ts/src/tray-signaling.ts` — update this file when that
// contract changes.

// MARK: - TraySessionDescription

public struct TraySessionDescription: Codable, Sendable {
    public let type: SDPType
    public let sdp: String

    public enum SDPType: String, Codable {
        case offer
        case answer
    }

    public init(type: SDPType, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

// MARK: - TrayIceCandidate

public struct TrayIceCandidate: Codable, Sendable {
    public let candidate: String
    public let sdpMid: String?
    public let sdpMLineIndex: Int?
    public let usernameFragment: String?

    public init(
        candidate: String,
        sdpMid: String?,
        sdpMLineIndex: Int?,
        usernameFragment: String?
    ) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.usernameFragment = usernameFragment
    }
}

// MARK: - TrayBootstrapState

public enum TrayBootstrapState: String, Codable, Sendable {
    case pending
    case offered
    case connected
    case failed
}

// MARK: - TrayBootstrapFailure

public struct TrayBootstrapFailure: Codable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let retryAfterMs: Int?
    public let failedAt: String
}

// MARK: - TrayBootstrapStatus

public struct TrayBootstrapStatus: Codable, Sendable {
    public let controllerId: String
    public let bootstrapId: String
    public let attempt: Int
    public let state: TrayBootstrapState
    public let expiresAt: String
    public let cursor: Int
    public let maxRetries: Int
    public let retriesRemaining: Int
    public let retryAfterMs: Int?
    public let failure: TrayBootstrapFailure?
}

// MARK: - TurnIceServer

public struct TurnIceServer: Codable, Sendable {
    public let urls: [String]
    public let username: String
    public let credential: String

    public init(urls: [String], username: String, credential: String) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

// MARK: - TrayLeaderSummary

public struct TrayLeaderSummary: Codable, Sendable {
    public let controllerId: String
    public let connected: Bool
    public let reconnectDeadline: String?
}

// MARK: - TrayBootstrapEvent

public enum TrayBootstrapEvent: Codable, Sendable {
    case offer(sequence: Int, sentAt: String, offer: TraySessionDescription)
    case iceCandidate(sequence: Int, sentAt: String, candidate: TrayIceCandidate)
    case failed(sequence: Int, sentAt: String, failure: TrayBootstrapFailure)

    private enum CodingKeys: String, CodingKey {
        case type, sequence, sentAt, offer, candidate, failure
    }

    public init(from decoder: Decoder) throws {
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
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown TrayBootstrapEvent type: \(type)"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .offer(let seq, let sent, let offer):
            try container.encode("bootstrap.offer", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(offer, forKey: .offer)
        case .iceCandidate(let seq, let sent, let cand):
            try container.encode("bootstrap.ice_candidate", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(cand, forKey: .candidate)
        case .failed(let seq, let sent, let fail):
            try container.encode("bootstrap.failed", forKey: .type)
            try container.encode(seq, forKey: .sequence)
            try container.encode(sent, forKey: .sentAt)
            try container.encode(fail, forKey: .failure)
        }
    }
}

// MARK: - FollowerAttachResult

enum FollowerAttachResult: Codable, Sendable {
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
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown action: \(action)"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .wait(let code, let retryAfterMs):
            try container.encode("wait", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(retryAfterMs, forKey: .retryAfterMs)
        case .signal(let code, let bootstrap):
            try container.encode("signal", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(bootstrap, forKey: .bootstrap)
        case .fail(let code, let error):
            try container.encode("fail", forKey: .action)
            try container.encode(code, forKey: .code)
            try container.encode(error, forKey: .error)
        }
    }
}

// MARK: - FollowerAttachResponse

struct FollowerAttachResponse: Codable, Sendable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let result: FollowerAttachResult
    let iceServers: [TurnIceServer]?
}

// MARK: - FollowerBootstrapResponse

struct FollowerBootstrapResponse: Codable, Sendable {
    let trayId: String
    let controllerId: String
    let role: String
    let leader: TrayLeaderSummary?
    let participantCount: Int
    let bootstrap: TrayBootstrapStatus
    let events: [TrayBootstrapEvent]
    let iceServers: [TurnIceServer]?
}
