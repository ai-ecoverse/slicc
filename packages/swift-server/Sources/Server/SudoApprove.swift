import Foundation
import HTTPTypes
import Hummingbird
import NIOCore

/// `POST /api/sudo-approve` — the native sudo approval endpoint for the
/// Sliccstart-bundled `slicc-server`.
///
/// **Mirrors `packages/node-server/src/sudo/endpoint.ts` +
/// `dialog-backends.ts` (`createOsascriptBackend`).** The in-browser broker
/// (`packages/webapp/src/sudo/http-broker.ts`) POSTs the gated action here;
/// this process is the only one that can raise a genuine native dialog (the
/// agent's browser `node` shim cannot reach it). The Hummingbird server runs
/// headless, so the dialog is raised by shelling out to `/usr/bin/osascript`
/// via `Process` — exactly like node-server. Loopback-only by construction
/// (the server binds 127.0.0.1).
///
/// Fail closed: an invalid body → 400; any backend throw, non-zero exit,
/// dismissed dialog, or unparsable output → `{ "decision": "deny" }`.
enum SudoApprove {

    /// Injectable osascript runner seam. Receives the argv passed after the
    /// `osascript` binary (e.g. `["-e", script]`) and resolves its stdout.
    /// Tests inject a stub so they can assert argv + parsing without spawning
    /// a real dialog.
    typealias OsascriptRunner = @Sendable ([String]) async throws -> String

    /// Valid `kind` values. Mirrors `VALID_KINDS` in node-server's endpoint.
    static let validKinds: Set<String> = ["command", "read", "write", "secret"]

    enum SudoApproveError: Error, Equatable {
        case nonZeroExit(code: Int32)
    }

    // MARK: - Shapes

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

    // MARK: - Mirrored helpers

    /// Human-readable one-liner describing the gated action. Mirrors
    /// `describeRequest` in node-server's `dialog-backends.ts`.
    static func describeRequest(_ req: ApproveRequest) -> String {
        "\(req.kind): \(req.detail)"
    }

    /// `suggestedPattern` (trimmed) when set, else `detail` (trimmed). Mirrors
    /// `fallbackPattern` in node-server.
    static func fallbackPattern(_ req: ApproveRequest) -> String {
        let trimmed = req.suggestedPattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return req.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Quote a string for AppleScript. Mirrors `q` in node-server: escape
    /// backslash, then double-quote.
    static func q(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Build the `osascript display dialog` script. Byte-equivalent to the
    /// script in node-server's `createOsascriptBackend`.
    static func buildScript(request: ApproveRequest, suggested: String) -> String {
        let message = "SLICC sudo — approve \(describeRequest(request))\n\nEdit pattern for \"Always\":"
        return "display dialog \(q(message)) default answer \(q(suggested)) "
            + "buttons {\"Deny\", \"Allow Once\", \"Always\"} default button \"Allow Once\" "
            + "with title \"SLICC sudo\" with icon caution"
    }

    /// Parse `button returned:` (up to the first comma / newline). Mirrors
    /// `/button returned:([^,\n]*)/`.
    static func parseButton(_ stdout: String) -> String {
        guard let range = stdout.range(of: "button returned:") else { return "" }
        var result = ""
        for ch in stdout[range.upperBound...] {
            if ch == "," || ch == "\n" { break }
            result.append(ch)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Parse `text returned:` (to end). Mirrors `/text returned:([\s\S]*)$/`.
    static func parseText(_ stdout: String) -> String {
        guard let range = stdout.range(of: "text returned:") else { return "" }
        return String(stdout[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Decision

    /// Raise the dialog and parse the gesture into a {@link Decision}. Mirrors
    /// `createOsascriptBackend.prompt`. Fail closed on any throw.
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

    /// Default runner: spawn `/usr/bin/osascript` on a background queue and
    /// resolve its stdout. A non-zero exit (Deny / dismissed dialog returns
    /// `-128`) throws so the decision falls closed to `deny`.
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

    // MARK: - HTTP routing

    /// Register `POST /api/sudo-approve` against the given router. `runner` is
    /// overridable for tests; production uses {@link defaultRunner}.
    static func registerRoutes(
        router: Router<some RequestContext>,
        runner: @escaping OsascriptRunner = defaultRunner
    ) {
        router.post("/api/sudo-approve") { request, _ in
            await handle(request: request, runner: runner)
        }
    }

    /// Decode + validate the envelope (invalid → 400), raise the dialog, and
    /// return the JSON `SudoDecision`.
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

    // MARK: - Internals

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
