import Foundation
import XCTest

@testable import SliccFollower
@testable import SliccTrayKit























final class SyncProtocolCorpusTests: XCTestCase {
    private struct CorpusError: Error, CustomStringConvertible {
        let description: String
    }

    private struct RawCorpus {
        let traySyncProtocolVersion: Int
        let declaredLeaderVariantCount: Int
        let declaredFollowerVariantCount: Int
        let declaredAgentEventVariantCount: Int
        let leaderToFollower: [(type: String, ios: String, messageData: Data)]
        
        
        let leaderToFollowerExtra: [(type: String, ios: String, messageData: Data)]
        let followerToLeader: [(type: String, ios: String, messageData: Data)]
        let agentEvents: [AgentEventFixture]
        let nestedPayloads: [NestedPayload]
    }

    
    
    
    private struct AgentEventFixture {
        let type: String
        let ios: String
        let mirrored: [String]
        let dropped: [String]
        let eventData: Data
    }

    
    
    private struct NestedPayload {
        let name: String
        let ios: String
        
        let mirrored: [String]
        
        
        let dropped: [String]
        let sampleData: Data
    }

    private func loadCorpus() throws -> RawCorpus {
        
        
        
        guard let url = Bundle(for: Self.self).url(forResource: "tray-sync-corpus", withExtension: "json") else {
            throw CorpusError(
                description: "tray-sync-corpus.json missing from test bundle — check the project.yml Fixtures copy")
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = root["traySyncProtocolVersion"] as? Int,
            let leaderCount = root["leaderVariantCount"] as? Int,
            let followerCount = root["followerVariantCount"] as? Int,
            let agentEventCount = root["agentEventVariantCount"] as? Int,
            let leader = root["leaderToFollower"] as? [[String: Any]],
            let leaderExtra = root["leaderToFollowerExtra"] as? [[String: Any]],
            let follower = root["followerToLeader"] as? [[String: Any]],
            let events = root["agentEvents"] as? [[String: Any]],
            let payloads = root["nestedPayloads"] as? [[String: Any]]
        else {
            throw CorpusError(description: "tray-sync-corpus.json has an unexpected shape — regenerate it")
        }
        func entries(_ items: [[String: Any]], payloadKey: String) throws -> [(String, String, Data)] {
            try items.map { item in
                let type = item["type"] as? String ?? "<missing>"
                let ios = item["ios"] as? String ?? "<missing>"
                let messageData = try JSONSerialization.data(withJSONObject: item[payloadKey] ?? [:])
                return (type, ios, messageData)
            }
        }
        return RawCorpus(
            traySyncProtocolVersion: version,
            declaredLeaderVariantCount: leaderCount,
            declaredFollowerVariantCount: followerCount,
            declaredAgentEventVariantCount: agentEventCount,
            leaderToFollower: try entries(leader, payloadKey: "message"),
            leaderToFollowerExtra: try entries(leaderExtra, payloadKey: "message"),
            followerToLeader: try entries(follower, payloadKey: "message"),
            agentEvents: try events.map { item in
                AgentEventFixture(
                    type: item["type"] as? String ?? "<missing>",
                    ios: item["ios"] as? String ?? "<missing>",
                    mirrored: item["mirrored"] as? [String] ?? [],
                    dropped: item["dropped"] as? [String] ?? [],
                    eventData: try JSONSerialization.data(withJSONObject: item["event"] ?? [:])
                )
            },
            nestedPayloads: try payloads.map { item in
                NestedPayload(
                    name: item["name"] as? String ?? "<missing>",
                    ios: item["ios"] as? String ?? "<missing>",
                    mirrored: item["mirrored"] as? [String] ?? [],
                    dropped: item["dropped"] as? [String] ?? [],
                    sampleData: try JSONSerialization.data(withJSONObject: item["sample"] ?? [:])
                )
            }
        )
    }

    
    
    
    private func roundTripThroughSwiftMirror(name: String, sample: Data) throws -> [String: Any]? {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        let reencoded: Data
        switch name {
        case "ChatMessage":
            reencoded = try encoder.encode(try decoder.decode(ChatMessage.self, from: sample))
        case "ChatCompactionMarker":
            reencoded = try encoder.encode(try decoder.decode(ChatCompactionMarker.self, from: sample))
        case "ToolCall":
            reencoded = try encoder.encode(try decoder.decode(ToolCall.self, from: sample))
        case "MessageAttachment":
            reencoded = try encoder.encode(try decoder.decode(MessageAttachment.self, from: sample))
        case "ScoopSummary":
            reencoded = try encoder.encode(try decoder.decode(ScoopSummary.self, from: sample))
        case "SprinkleSummary":
            reencoded = try encoder.encode(try decoder.decode(SprinkleSummary.self, from: sample))
        case "RemoteTargetInfo":
            reencoded = try encoder.encode(try decoder.decode(RemoteTargetInfo.self, from: sample))
        case "TrayTargetEntry":
            reencoded = try encoder.encode(try decoder.decode(TrayTargetEntry.self, from: sample))
        case "TrayFsRequest":
            reencoded = try encoder.encode(try decoder.decode(TrayFsRequest.self, from: sample))
        case "TrayFsResponse":
            reencoded = try encoder.encode(try decoder.decode(TrayFsResponse.self, from: sample))
        case "ComputerDescriptor":
            reencoded = try encoder.encode(try decoder.decode(ComputerDescriptor.self, from: sample))
        default:
            return nil
        }
        return try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
    }

    func testCorpusVersionMatchesThisBuild() throws {
        let corpus = try loadCorpus()
        XCTAssertEqual(
            corpus.traySyncProtocolVersion, traySyncProtocolVersion,
            "Corpus protocol version drifted from SyncProtocol.swift — regenerate / update the mirror")
    }

    func testCorpusCountsMatchDeclaredCounts() throws {
        
        
        
        let corpus = try loadCorpus()
        XCTAssertEqual(corpus.leaderToFollower.count, corpus.declaredLeaderVariantCount)
        XCTAssertEqual(corpus.followerToLeader.count, corpus.declaredFollowerVariantCount)
        XCTAssertEqual(
            Set(corpus.leaderToFollower.map(\.type)).count, corpus.leaderToFollower.count,
            "duplicate leaderToFollower fixture types")
        XCTAssertEqual(
            Set(corpus.followerToLeader.map(\.type)).count, corpus.followerToLeader.count,
            "duplicate followerToLeader fixture types")
        XCTAssertEqual(corpus.agentEvents.count, corpus.declaredAgentEventVariantCount)
        XCTAssertEqual(
            Set(corpus.agentEvents.map(\.type)).count, corpus.agentEvents.count,
            "duplicate agentEvents fixture types")
    }

    
    
    
    func testAgentEventCorpusDecodesPerExpectation() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        for fixture in corpus.agentEvents {
            let decoded: AgentEvent
            do {
                decoded = try decoder.decode(AgentEvent.self, from: fixture.eventData)
            } catch {
                XCTFail("agentEvent '\(fixture.type)' failed to decode entirely: \(error)")
                continue
            }
            let isUnknown: Bool
            if case .unknown = decoded { isUnknown = true } else { isUnknown = false }
            switch fixture.ios {
            case "decoded":
                XCTAssertFalse(
                    isUnknown,
                    "agent event '\(fixture.type)' decoded to .unknown but the corpus expects a real case — AgentEvent in SyncProtocol.swift is missing it")
            case "unknown":
                XCTAssertTrue(
                    isUnknown,
                    "agent event '\(fixture.type)' now decodes to a real case — flip its expectation to 'decoded' in tray-sync-protocol-corpus.ts")
            default:
                XCTFail("agent event '\(fixture.type)' has unexpected ios expectation '\(fixture.ios)'")
            }
        }
    }

    
    
    
    
    
    func testAgentEventPayloadFieldsSurviveTheSwiftMirror() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        for fixture in corpus.agentEvents {
            guard let decoded = try? decoder.decode(AgentEvent.self, from: fixture.eventData) else {
                continue  
            }
            let survived =
                try JSONSerialization.jsonObject(with: try encoder.encode(decoded)) as? [String: Any] ?? [:]
            for field in fixture.mirrored {
                XCTAssertNotNil(
                    survived[field],
                    "agent event '\(fixture.type).\(field)' is expected to survive but the Swift mirror dropped it")
            }
            for field in fixture.dropped {
                XCTAssertNil(
                    survived[field],
                    "agent event '\(fixture.type).\(field)' now survives — promote it to 'mirrored' in tray-sync-protocol-corpus.ts")
            }
        }
    }

    
    
    
    
    
    
    
    
    
    func testNestedPayloadFieldsSurviveTheSwiftMirror() throws {
        let corpus = try loadCorpus()
        for payload in corpus.nestedPayloads {
            guard let survived = try roundTripThroughSwiftMirror(name: payload.name, sample: payload.sampleData)
            else {
                XCTAssertEqual(
                    payload.ios, "absent",
                    "'\(payload.name)' is declared mirrored but has no Swift type wired into roundTripThroughSwiftMirror")
                continue
            }
            XCTAssertEqual(
                payload.ios, "mirrored",
                "'\(payload.name)' has a Swift mirror wired in but the corpus declares it '\(payload.ios)' — update tray-sync-protocol-corpus.ts")
            for field in payload.mirrored {
                XCTAssertNotNil(
                    survived[field],
                    "'\(payload.name).\(field)' is expected to survive but the Swift mirror dropped it")
            }
            for field in payload.dropped {
                XCTAssertNil(
                    survived[field],
                    "'\(payload.name).\(field)' now survives the Swift mirror — promote it to 'mirrored' in tray-sync-protocol-corpus.ts")
            }
        }
    }

    func testLeaderToFollowerCorpusDecodesPerExpectation() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        for (type, ios, messageData) in corpus.leaderToFollower + corpus.leaderToFollowerExtra {
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

    func testLeaderToFollowerExtraShapesExtendKeyedVariants() throws {
        let corpus = try loadCorpus()
        let keyed = Dictionary(uniqueKeysWithValues: corpus.leaderToFollower.map { ($0.type, $0.ios) })
        for extra in corpus.leaderToFollowerExtra {
            XCTAssertEqual(
                keyed[extra.type], extra.ios,
                "leaderToFollowerExtra '\(extra.type)' must extend a keyed fixture with the same ios expectation")
        }
    }

    
    
    func testUserMessageAckCorpusShapesKeepStateAndError() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        var states: [UserMessageAckState: String?] = [:]
        for fixture in corpus.leaderToFollower + corpus.leaderToFollowerExtra
        where fixture.type == "user_message_ack" {
            guard
                case .userMessageAck(_, _, let state, let error) = try decoder.decode(
                    LeaderToFollowerMessage.self, from: fixture.messageData)
            else {
                XCTFail("a user_message_ack fixture decoded to a different case")
                continue
            }
            states[state] = error
        }
        XCTAssertEqual(states.keys.sorted { $0.rawValue < $1.rawValue }, [.accepted, .rejected])
        XCTAssertEqual(states[.accepted], .some(nil), "accepted carries no error")
        XCTAssertNotNil(states[.rejected], "rejected must keep the leader's error")
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

    func testFollowerHelloCorpusCapabilitiesMatchThisBuild() throws {
        let corpus = try loadCorpus()
        let fixture = try XCTUnwrap(corpus.followerToLeader.first { $0.type == "hello" })
        let decoded = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: fixture.messageData)
        guard case .hello(_, _, let capabilities, _, _) = decoded else {
            return XCTFail("followerToLeader 'hello' fixture decoded to a different case")
        }
        XCTAssertEqual(
            capabilities?.exec, trayFollowerCapabilities.exec,
            "followerToLeader 'hello.capabilities.exec' drifted from trayFollowerCapabilities — regenerate the corpus")
    }

    func testDecodedLeaderMessagesReencodeWithSameType() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        for (type, ios, messageData) in corpus.leaderToFollower + corpus.leaderToFollowerExtra
        where ios == "decoded" {
            let decoded = try decoder.decode(LeaderToFollowerMessage.self, from: messageData)
            let reencoded = try encoder.encode(decoded)
            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertEqual(obj?["type"] as? String, type, "'\(type)' re-encoded with a different type tag")
        }
    }

    func testDecodedFollowerMessagesReencodeWithSameType() throws {
        let corpus = try loadCorpus()
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        for (type, ios, messageData) in corpus.followerToLeader where ios == "decoded" {
            let decoded = try decoder.decode(FollowerToLeaderMessage.self, from: messageData)
            let reencoded = try encoder.encode(decoded)
            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertEqual(obj?["type"] as? String, type, "'\(type)' re-encoded with a different type tag")
            guard type == "hello" else { continue }

            let fixture = try XCTUnwrap(
                JSONSerialization.jsonObject(with: messageData) as? [String: Any])
            XCTAssertEqual(
                obj?["protocolVersion"] as? Int, fixture["protocolVersion"] as? Int,
                "'hello.protocolVersion' changed during decode → encode")
            XCTAssertEqual(
                obj?["runtime"] as? String, fixture["runtime"] as? String,
                "'hello.runtime' changed during decode → encode")
            XCTAssertEqual(
                obj?["capabilities"] as? NSDictionary, fixture["capabilities"] as? NSDictionary,
                "'hello.capabilities' changed during decode → encode")
            XCTAssertEqual(
                obj?["motd"] as? String, fixture["motd"] as? String,
                "'hello.motd' changed during decode → encode")
        }
    }
}
