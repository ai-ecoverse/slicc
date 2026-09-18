import Foundation
import HTTPTypes
import Hummingbird
import NIOCore

















enum SudoApprove {

    
    
    
    
    typealias OsascriptRunner = @Sendable ([String]) async throws -> String

    
    static let validKinds: Set<String> = ["command", "read", "write", "secret"]

    enum SudoApproveError: Error, Equatable {
        case nonZeroExit(code: Int32)
    }

    

    struct ApproveRequest: Equatable {
        let kind: String
        let detail: String
        let suggestedPattern: String?
    }

    struct Decision: Equatable {
        let decision: String
        let pattern: String?
    }

    private struct RequestEnvelope: Decodable {
        let kind: String
        let detail: String
        let suggestedPattern: String?
    }

    

    
    
    static func describeRequest(_ req: ApproveRequest) -> String {
        "\(req.kind): \(req.detail)"
    }

    
    
    static func fallbackPattern(_ req: ApproveRequest) -> String {
        let trimmed = req.suggestedPattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return req.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    
    
    static func q(_ s: String) -> String {
        "\""
            + s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    
    
    static func buildScript(request: ApproveRequest, suggested: String) -> String {
        let message = "SLICC sudo — approve \(describeRequest(request))\n\nEdit pattern for \"Always\":"
        return "display dialog \(q(message)) default answer \(q(suggested)) "
            + "buttons {\"Deny\", \"Allow Once\", \"Always\"} default button \"Allow Once\" "
            + "with title \"SLICC sudo\" with icon caution"
    }

    
    
    static func parseButton(_ stdout: String) -> String {
        guard let range = stdout.range(of: "button returned:") else { return "" }
        var result = ""
        for ch in stdout[range.upperBound...] {
            if ch == "," || ch == "\n" { break }
            result.append(ch)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    
    static func parseText(_ stdout: String) -> String {
        guard let range = stdout.range(of: "text returned:") else { return "" }
        return String(stdout[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    

    
    
    static func decide(request: ApproveRequest, runner: OsascriptRunner) async -> Decision {
        let suggested = fallbackPattern(request)
        let script = buildScript(request: request, suggested: suggested)
        do {
            let stdout = try await runner(["-e", script])
            let button = parseButton(stdout)
            let text = parseText(stdout)
            if button == "Allow Once" { return Decision(decision: "allow", pattern: nil) }
            if button == "Always" {
                return Decision(decision: "always", pattern: text.isEmpty ? suggested : text)
            }
            return Decision(decision: "deny", pattern: nil)
        } catch {
            return Decision(decision: "deny", pattern: nil)
        }
    }

    
    
    
    static let defaultRunner: OsascriptRunner = { args in
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                process.arguments = args
                let stdoutPipe = Pipe()
                process.standardOutput = stdoutPipe
                process.standardError = FileHandle.nullDevice
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    continuation.resume(throwing: SudoApproveError.nonZeroExit(code: process.terminationStatus))
                    return
                }
                continuation.resume(returning: String(data: data, encoding: .utf8) ?? "")
            }
        }
    }

    

    
    
    static func registerRoutes(
        router: Router<some RequestContext>,
        runner: @escaping OsascriptRunner = defaultRunner
    ) {
        router.post("/api/sudo-approve") { request, _ in
            await handle(request: request, runner: runner)
        }
    }

    
    
    static func handle(request: Request, runner: OsascriptRunner) async -> Response {
        let env: RequestEnvelope
        do {
            env = try await decodeEnvelope(request: request)
        } catch {
            return badRequest()
        }
        guard validKinds.contains(env.kind) else { return badRequest() }
        guard !env.detail.isEmpty else { return badRequest() }

        let decision = await decide(
            request: ApproveRequest(kind: env.kind, detail: env.detail, suggestedPattern: env.suggestedPattern),
            runner: runner
        )
        return decisionResponse(decision)
    }

    

    private static func decodeEnvelope(request: Request) async throws -> RequestEnvelope {
        let buffer = try await request.body.collect(upTo: 1 * 1024 * 1024)
        var b = buffer
        let data = b.readData(length: b.readableBytes) ?? Data()
        return try JSONDecoder().decode(RequestEnvelope.self, from: data)
    }

    private static func decisionResponse(_ decision: Decision) -> Response {
        var object: [String: LickSystem.JSONValue] = ["decision": .string(decision.decision)]
        if let pattern = decision.pattern {
            object["pattern"] = .string(pattern)
        }
        return jsonResponse(.object(object), status: .ok)
    }

    private static func badRequest() -> Response {
        jsonResponse(.object(["error": .string("invalid sudo-approve payload")]), status: .badRequest)
    }

    private static func jsonResponse(_ value: LickSystem.JSONValue, status: HTTPResponse.Status) -> Response {
        let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
        return Response(
            status: status,
            headers: [.contentType: "application/json; charset=utf-8"],
            body: .init(byteBuffer: ByteBuffer(bytes: data))
        )
    }
}
