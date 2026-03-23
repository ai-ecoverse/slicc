import Foundation
import Logging

private let consoleForwarderPollAttempts = 20
private let consoleForwarderPollDelayNanoseconds: UInt64 = 500_000_000
private let consoleForwarderReconnectDelayNanoseconds: UInt64 = 1_000_000_000
private let consoleForwarderYellow = "\u{1b}[33m"
private let consoleForwarderRed = "\u{1b}[31m"
private let consoleForwarderReset = "\u{1b}[0m"

actor ConsoleForwarder {
    private let session: URLSession
    private let logger: Logger
    private let output: @Sendable (String) -> Void
    private let logDedup: CliLogDedup

    private var runID = UUID()
    private var loopTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?

    init(
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.console-forwarder"),
        output: @escaping @Sendable (String) -> Void = { print($0) }
    ) {
        self.session = session
        self.logger = logger
        self.output = output
        self.logDedup = CliLogDedup(prefix: "[page]", sink: output)
    }

    func start(cdpPort: Int, pageUrl: String) {
        stop()

        let runID = UUID()
        self.runID = runID
        self.loopTask = Task { [weak self] in
            await self?.runLoop(runID: runID, cdpPort: cdpPort, pageUrl: pageUrl)
        }
    }

    func stop() {
        runID = UUID()
        loopTask?.cancel()
        loopTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        logDedup.flush()
    }

    private func runLoop(runID: UUID, cdpPort: Int, pageUrl: String) async {
        while isCurrentRun(runID), !Task.isCancelled {
            do {
                guard let target = try await discoverPageTarget(cdpPort: cdpPort, pageUrl: pageUrl) else {
                    output("[page] Could not find page target — console forwarding disabled")
                    return
                }

                guard let webSocketDebuggerURL = target.webSocketDebuggerURL else {
                    output("[page] Could not find page target — console forwarding disabled")
                    return
                }

                try await forwardConsoleMessages(to: webSocketDebuggerURL, runID: runID)
            } catch is CancellationError {
                break
            } catch {
                guard isCurrentRun(runID), !Task.isCancelled else { break }
                logger.debug("Console forwarder connection dropped", metadata: ["error": .string(error.localizedDescription)])
            }

            guard isCurrentRun(runID), !Task.isCancelled else { break }

            do {
                try await Task.sleep(nanoseconds: consoleForwarderReconnectDelayNanoseconds)
            } catch {
                break
            }
        }
    }

    private func discoverPageTarget(cdpPort: Int, pageUrl: String) async throws -> ConsolePageTarget? {
        let listURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/list")!

        for attempt in 0..<consoleForwarderPollAttempts {
            try Task.checkCancellation()

            do {
                var request = URLRequest(url: listURL)
                request.timeoutInterval = 1

                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw ConsoleForwarderError.discoveryFailed("Unexpected response from /json/list")
                }

                let targets = try JSONDecoder().decode([ConsolePageTarget].self, from: data)
                if let match = selectConsolePageTarget(from: targets, matching: pageUrl) {
                    return match
                }
            } catch let error as CancellationError {
                throw error
            } catch {
                logger.debug("Console target discovery attempt failed", metadata: [
                    "attempt": .stringConvertible(attempt + 1),
                    "error": .string(error.localizedDescription),
                ])
            }

            if attempt + 1 < consoleForwarderPollAttempts {
                try await Task.sleep(nanoseconds: consoleForwarderPollDelayNanoseconds)
            }
        }

        return nil
    }

    private func forwardConsoleMessages(to webSocketDebuggerURL: String, runID: UUID) async throws {
        guard let url = URL(string: webSocketDebuggerURL) else {
            throw ConsoleForwarderError.invalidWebSocketURL(webSocketDebuggerURL)
        }

        let socket = session.webSocketTask(with: url)
        self.socket = socket
        socket.resume()

        defer {
            if self.socket === socket {
                self.socket = nil
            }
            socket.cancel(with: .goingAway, reason: nil)
        }

        try await send(message: ["id": 1, "method": "Runtime.enable"], over: socket)

        while isCurrentRun(runID), !Task.isCancelled {
            let message = try await socket.receive()
            if let event = decodeConsoleEvent(from: message) {
                handleConsoleEvent(event)
            }
        }
    }

    private func handleConsoleEvent(_ event: ConsoleEvent) {
        let dedupLine = consoleTaggedLine(args: event.args)
        guard logDedup.shouldLog(dedupLine) else { return }
        output(renderedConsoleLine(type: event.type, args: event.args))
    }

    private func send(message: [String: Any], over socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CocoaError(.coderInvalidValue)
        }
        try await socket.send(.string(text))
    }

    private func decodeConsoleEvent(from message: URLSessionWebSocketTask.Message) -> ConsoleEvent? {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let payload):
            data = payload
        @unknown default:
            return nil
        }

        guard let envelope = try? JSONDecoder().decode(ConsoleEventEnvelope.self, from: data),
              envelope.method == "Runtime.consoleAPICalled",
              let event = envelope.params else {
            return nil
        }
        return event
    }

    private func isCurrentRun(_ runID: UUID) -> Bool {
        self.runID == runID
    }
}

enum ConsoleForwarderError: Error, LocalizedError {
    case discoveryFailed(String)
    case invalidWebSocketURL(String)

    var errorDescription: String? {
        switch self {
        case .discoveryFailed(let message), .invalidWebSocketURL(let message):
            return message
        }
    }
}

struct ConsolePageTarget: Decodable, Equatable, Sendable {
    let type: String
    let url: String
    let webSocketDebuggerURL: String?

    enum CodingKeys: String, CodingKey {
        case type
        case url
        case webSocketDebuggerURL = "webSocketDebuggerUrl"
    }
}

struct ConsoleEventEnvelope: Decodable, Sendable {
    let method: String?
    let params: ConsoleEvent?
}

struct ConsoleEvent: Decodable, Equatable, Sendable {
    let type: String
    let args: [ConsoleRemoteObject]
}

struct ConsoleRemoteObject: Decodable, Equatable, Sendable {
    let type: String
    let value: ConsoleJSONValue?
    let description: String?
}

enum ConsoleJSONValue: Decodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: ConsoleJSONValue])
    case array([ConsoleJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: ConsoleJSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([ConsoleJSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value.rounded(.towardZero) == value ? String(Int(value)) : String(value)
        case .bool(let value):
            return String(value)
        case .null:
            return "null"
        case .object, .array:
            guard JSONSerialization.isValidJSONObject(jsonObject) else { return "<unserializable>" }
            let data = try? JSONSerialization.data(withJSONObject: jsonObject)
            return data.flatMap { String(data: $0, encoding: .utf8) } ?? "<unserializable>"
        }
    }

    private var jsonObject: Any {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value
        case .bool(let value):
            return value
        case .null:
            return NSNull()
        case .object(let value):
            return value.mapValues(\.jsonObject)
        case .array(let value):
            return value.map(\.jsonObject)
        }
    }
}

func selectConsolePageTarget(from targets: [ConsolePageTarget], matching pageURL: String) -> ConsolePageTarget? {
    targets.first { target in
        target.type == "page"
            && target.webSocketDebuggerURL != nil
            && matchesConsolePageURL(target.url, expectedPageURL: pageURL)
    }
}

func matchesConsolePageURL(_ targetURL: String, expectedPageURL: String) -> Bool {
    let expected = expectedPageURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !expected.isEmpty else { return false }

    if let expectedPort = Int(expected),
       let components = URLComponents(string: targetURL),
       let host = components.host?.lowercased() {
        return ["localhost", "127.0.0.1"].contains(host) && components.port == expectedPort
    }

    return targetURL == expected || targetURL.contains(expected)
}

func serializeConsoleArgument(_ arg: ConsoleRemoteObject) -> String {
    if let value = arg.value {
        return value.stringValue
    }
    if let description = arg.description, !description.isEmpty {
        return description
    }
    return arg.type
}

func consoleTaggedLine(args: [ConsoleRemoteObject]) -> String {
    let renderedArgs = args.map(serializeConsoleArgument).joined(separator: " ")
    return renderedArgs.isEmpty ? "[page]" : "[page] \(renderedArgs)"
}

func renderedConsoleLine(type: String, args: [ConsoleRemoteObject]) -> String {
    let line = consoleTaggedLine(args: args)
    switch type {
    case "warning":
        return "\(consoleForwarderYellow)\(line)\(consoleForwarderReset)"
    case "error":
        return "\(consoleForwarderRed)\(line)\(consoleForwarderReset)"
    default:
        return line
    }
}