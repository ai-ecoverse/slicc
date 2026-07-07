import XCTest
import Foundation
@testable import SliccFollower

/// Golden-fixture corpus tests (#1294 P0-2).
///
/// Decodes every message variant of the tray sync wire protocol from
/// `Fixtures/tray-sync-corpus.json` — the same bytes the TS suite
/// (`packages/webapp/tests/scoops/tray-sync-corpus.test.ts`) verifies against
/// the canonical TS unions — and asserts each variant's explicit iOS
/// expectation:
///  - `decoded`: `SyncProtocol.swift` must decode it to a real case.
///  - `unknown`: TS-only leader→follower variant — must decode to `.unknown`.
///  - `undecodable`: TS-only follower→leader variant — the decoder must throw.
///
/// A TS-side union change regenerates the corpus (the TS mapped types force a
/// fixture + iOS decision per variant), so a variant this decoder mishandles
/// fails HERE, in CI, instead of shipping as silently-dropped messages — the
/// `theme.apply` drift class.
final class SyncProtocolCorpusTests: XCTestCase {
    private struct CorpusEntry: Decodable {
        let type: String
        let ios: String
        // Raw JSON for the message re-extracted from the file separately.
    }

    private struct RawCorpus {
        let traySyncProtocolVersion: Int
        let leaderToFollower: [(type: String, ios: String, messageData: Data)]
        let followerToLeader: [(type: String, ios: String, messageData: Data)]
    }

    private func loadCorpus() throws -> RawCorpus {
        guard let url = Bundle(for: Self.self).url(forResource: "tray-sync-corpus", withExtension: "json") else {
            throw XCTSkip("tray-sync-corpus.json missing from test bundle resources")
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = root["traySyncProtocolVersion"] as? Int,
              let leader = root["leaderToFollower"] as? [[String: Any]],
              let follower = root["followerToLeader"] as? [[String: Any]] else {
            return RawCorpus(traySyncProtocolVersion: -1, leaderToFollower: [], followerToLeader: [])
        }
        func entries(_ items: [[String: Any]]) throws -> [(String, String, Data)] {
            try items.map { item in
                let type = item["type"] as? String ?? "<missing>"
                let ios = item["ios"] as? String ?? "<missing>"
                let messageData = try JSONSerialization.data(withJSONObject: item["message"] ?? [:])
                return (type, ios, messageData)
            }
        }
        return RawCorpus(
            traySyncProtocolVersion: version,
            leaderToFollower: try entries(leader),
            followerToLeader: try entries(follower)
        )
    }

    func testCorpusVersionMatchesThisBuild() throws {
        let corpus = try loadCorpus()
        XCTAssertEqual(
            corpus.traySyncProtocolVersion, traySyncProtocolVersion,
            "Corpus protocol version drifted from SyncProtocol.swift — regenerate / update the mirror")
    }

    func testCorpusIsNonEmpty() throws {
        let corpus = try loadCorpus()
        XCTAssertGreaterThan(corpus.leaderToFollower.count, 20)
        XCTAssertGreaterThan(corpus.followerToLeader.count, 15)
    }

    func testLeaderToFollowerCorpusDecodesPerExpectation() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        for (type, ios, messageData) in corpus.leaderToFollower {
            let decoded: LeaderToFollowerMessage
            do {
                decoded = try decoder.decode(LeaderToFollowerMessage.self, from: messageData)
            } catch {
                XCTFail("leaderToFollower '\(type)' failed to decode entirely: \(error)")
                continue
            }
            let isUnknown: Bool
            if case .unknown = decoded { isUnknown = true } else { isUnknown = false }
            switch ios {
            case "decoded":
                XCTAssertFalse(
                    isUnknown,
                    "'\(type)' decoded to .unknown but the corpus expects a real case — SyncProtocol.swift is missing it (theme.apply drift class)")
            case "unknown":
                XCTAssertTrue(
                    isUnknown,
                    "'\(type)' decoded to a real case but the corpus marks it TS-only — update the corpus expectation in tray-sync-protocol-corpus.ts")
            default:
                XCTFail("'\(type)' has unexpected ios expectation '\(ios)'")
            }
        }
    }

    func testFollowerToLeaderCorpusDecodesPerExpectation() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        for (type, ios, messageData) in corpus.followerToLeader {
            switch ios {
            case "decoded":
                XCTAssertNoThrow(
                    try decoder.decode(FollowerToLeaderMessage.self, from: messageData),
                    "'\(type)' should decode — SyncProtocol.swift is missing it")
            case "undecodable":
                XCTAssertThrowsError(
                    try decoder.decode(FollowerToLeaderMessage.self, from: messageData),
                    "'\(type)' decoded but the corpus marks it TS-only — update the corpus expectation in tray-sync-protocol-corpus.ts")
            default:
                XCTFail("'\(type)' has unexpected ios expectation '\(ios)'")
            }
        }
    }

    func testDecodedLeaderMessagesReencodeWithSameType() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        for (type, ios, messageData) in corpus.leaderToFollower where ios == "decoded" {
            let decoded = try decoder.decode(LeaderToFollowerMessage.self, from: messageData)
            let reencoded = try encoder.encode(decoded)
            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertEqual(obj?["type"] as? String, type, "'\(type)' re-encoded with a different type tag")
        }
    }
}
