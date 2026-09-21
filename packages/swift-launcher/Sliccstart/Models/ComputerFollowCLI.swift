import Foundation


















enum ComputerFollowCLI {
    
    
    enum Request: Equatable {
        
        case follow(joinUrl: String, pairId: String?)
        
        case preflight(json: Bool)
    }

    static let followFlag = "--computer-follow"
    static let pairFlag = "--pair"
    static let preflightFlag = "--computer-preflight"
    static let jsonFlag = "--json"

    
    
    
    
    
    
    
    
    
    
    
    
    static let readyLine = "SLICC_COMPUTER_FOLLOW_READY"

    
    
    
    
    static let attachedLine = "SLICC_COMPUTER_FOLLOW_ATTACHED"

    
    
    static let failedPrefix = "SLICC_COMPUTER_FOLLOW_FAILED"

    
    
    
    static func failedLine(reason: String) -> String {
        let flattened = reason.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        return flattened.isEmpty ? failedPrefix : "\(failedPrefix) \(flattened)"
    }

    
    
    
    struct AttachReporter: Equatable {
        enum Action: Equatable {
            case none
            case print(String)
            
            case printAndExit(String, Int32)
        }

        private(set) var attached = false

        
        
        mutating func connected() -> Action {
            guard !attached else { return .none }
            attached = true
            return .print(ComputerFollowCLI.attachedLine)
        }

        
        
        
        
        mutating func gaveUp(_ reason: String) -> Action {
            .printAndExit(ComputerFollowCLI.failedLine(reason: reason), 1)
        }
    }

    

    
    
    
    
    
    
    
    static func parentIsGone(parentPid: Int32) -> Bool { parentPid <= 1 }

    enum ParseError: Error, Equatable {
        case missingJoinUrl
        case invalidJoinUrl(String)
        case missingPairId

        var message: String {
            switch self {
            case .missingJoinUrl:
                return "Sliccstart \(followFlag): missing the join URL\n"
            case .invalidJoinUrl(let raw):
                return
                    "Sliccstart \(followFlag): \(raw) is not an http(s) join URL\n"
            case .missingPairId:
                return "Sliccstart \(followFlag): \(pairFlag) needs a value\n"
            }
        }
    }

    
    
    
    
    
    
    
    static func parse(_ argv: [String]) throws -> Request? {
        let args = Array(argv.dropFirst())
        if args.contains(preflightFlag) {
            return .preflight(json: args.contains(jsonFlag))
        }
        guard let followIndex = args.firstIndex(of: followFlag) else { return nil }

        let joinIndex = args.index(after: followIndex)
        guard joinIndex < args.endIndex else { throw ParseError.missingJoinUrl }
        let rawJoinUrl = args[joinIndex]
        guard isJoinUrl(rawJoinUrl) else { throw ParseError.invalidJoinUrl(rawJoinUrl) }

        return .follow(joinUrl: rawJoinUrl, pairId: try pairId(in: args))
    }

    
    
    
    static func isJoinUrl(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return false }
        guard scheme == "https" || scheme == "http" else { return false }
        return !(url.host ?? "").isEmpty
    }

    private static func pairId(in args: [String]) throws -> String? {
        guard let flagIndex = args.firstIndex(of: pairFlag) else { return nil }
        let valueIndex = args.index(after: flagIndex)
        guard valueIndex < args.endIndex else { throw ParseError.missingPairId }
        let value = args[valueIndex]
        guard !value.isEmpty, !value.hasPrefix("--") else { throw ParseError.missingPairId }
        return value
    }

    

    
    struct Grants: Codable, Equatable {
        
        var screenRecording: Bool
        
        
        var accessibility: Bool

        var complete: Bool { screenRecording && accessibility }
    }

    
    
    
    
    
    
    static func resolveGrants(using probe: ComputerPermissionProbe) -> Grants {
        Grants(
            screenRecording: probe.screenRecordingGranted() || probe.requestScreenRecording(),
            accessibility: probe.accessibilityGranted() || probe.requestAccessibility())
    }

    
    
    
    static func preflight(
        using probe: ComputerPermissionProbe,
        json: Bool,
        writeOut: (Data) -> Void,
        writeErr: (Data) -> Void
    ) -> Int32 {
        let grants = resolveGrants(using: probe)
        do {
            writeOut(try report(grants, json: json))
        } catch {
            writeErr(Data("Sliccstart: failed to encode permission state\n".utf8))
            return 1
        }
        return exitCode(for: grants)
    }

    
    static func report(_ grants: Grants, json: Bool) throws -> Data {
        guard json else { return Data(describe(grants).utf8) }
        var data = try encode(grants)
        data.append(0x0A)
        return data
    }

    
    static func encode(_ grants: Grants) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(grants)
    }

    
    static func describe(_ grants: Grants) -> String {
        var lines = [
            "Screen Recording: \(word(grants.screenRecording))",
            "Accessibility:    \(word(grants.accessibility))",
        ]
        if !grants.complete {
            
            
            
            lines.append("")
            lines.append(
                "Grant the missing ones to Sliccstart in System Settings ▸ Privacy & Security."
            )
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func word(_ granted: Bool) -> String { granted ? "granted" : "not granted" }

    
    
    
    
    
    static func exitCode(for grants: Grants) -> Int32 { grants.complete ? 0 : 3 }

    
    static let usageExitCode: Int32 = 2
}
