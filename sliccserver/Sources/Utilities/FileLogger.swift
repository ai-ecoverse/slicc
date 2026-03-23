import Foundation
import Logging

private let sevenDaysInSeconds: TimeInterval = 7 * 24 * 60 * 60

struct FileLoggerConfiguration: Sendable {
    var logDirectory: URL
    var logLevel: Logger.Level
    var cleanup: Bool

    init(
        logDirectory: URL = FileLogger.defaultLogDirectory,
        logLevel: Logger.Level = .info,
        cleanup: Bool = true
    ) {
        self.logDirectory = logDirectory
        self.logLevel = logLevel
        self.cleanup = cleanup
    }
}

struct FileLogger: LogHandler, Sendable {
    static let defaultLogDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".slicc", isDirectory: true)
        .appendingPathComponent("logs", isDirectory: true)

    private let label: String
    private let sink: FileLogSink

    var metadata: Logger.Metadata = [:]
    var logLevel: Logger.Level

    init(label: String, configuration: FileLoggerConfiguration = .init()) {
        self.label = label
        self.logLevel = configuration.logLevel
        self.sink = FileLogSink(configuration: configuration)
    }

    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    var logFileURL: URL? {
        sink.currentLogFileURL
    }

    func close() {
        sink.close()
    }

    func log(
        level: Logger.Level,
        message: Logger.Message,
        metadata explicitMetadata: Logger.Metadata?,
        source: String,
        file: String,
        function: String,
        line: UInt
    ) {
        guard level >= logLevel else { return }

        var mergedMetadata = metadata
        if let explicitMetadata {
            mergedMetadata.merge(explicitMetadata, uniquingKeysWith: { _, new in new })
        }

        let record = FileLogRecord(
            timestamp: iso8601Timestamp(for: Date()),
            level: level.rawValue,
            label: label,
            message: stripANSI(message.description),
            metadata: mergedMetadata.isEmpty ? nil : jsonMetadata(from: mergedMetadata),
            source: source,
            file: file,
            function: function,
            line: line,
            processID: ProcessInfo.processInfo.processIdentifier
        )

        sink.write(record)
    }
}

enum SliccLogging {
    static func bootstrap(
        logLevel: Logger.Level = .info,
        logDirectory: URL = FileLogger.defaultLogDirectory,
        teeToConsole: Bool = true
    ) {
        let configuration = FileLoggerConfiguration(logDirectory: logDirectory, logLevel: logLevel)
        LoggingSystem.bootstrap { label in
            var fileHandler = FileLogger(label: label, configuration: configuration)
            fileHandler.logLevel = logLevel
            guard teeToConsole else {
                return fileHandler
            }

            var consoleHandler = StreamLogHandler.standardOutput(label: label)
            consoleHandler.logLevel = logLevel
            return MultiplexLogHandler([consoleHandler, fileHandler])
        }
    }
}

func cleanupOldLogs(in directory: URL, maxAge: TimeInterval = sevenDaysInSeconds) {
    let fileManager = FileManager.default
    let resourceKeys: Set<URLResourceKey> = [.contentModificationDateKey]

    guard let entries = try? fileManager.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: Array(resourceKeys),
        options: [.skipsHiddenFiles]
    ) else {
        return
    }

    let cutoff = Date().addingTimeInterval(-maxAge)
    for entry in entries where entry.pathExtension == "log" {
        guard
            let values = try? entry.resourceValues(forKeys: resourceKeys),
            let modifiedAt = values.contentModificationDate,
            modifiedAt < cutoff
        else {
            continue
        }

        try? fileManager.removeItem(at: entry)
    }
}

func stripANSI(_ value: String) -> String {
    let range = NSRange(location: 0, length: value.utf16.count)
    return ansiRegex.stringByReplacingMatches(in: value, options: [], range: range, withTemplate: "")
}

private let ansiRegex = try! NSRegularExpression(
    pattern: #"\u001B\[[0-9;]*[A-Za-z]|\u001B\].*?\u0007|\u001B[^\[].?"#,
    options: []
)

private struct FileLogRecord: Encodable, Sendable {
    let timestamp: String
    let level: String
    let label: String
    let message: String
    let metadata: [String: JSONValue]?
    let source: String
    let file: String
    let function: String
    let line: UInt
    let processID: Int32
}

private enum JSONValue: Encodable, Sendable {
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    func encode(to encoder: Encoder) throws {
        switch self {
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .array(let value):
            var container = encoder.unkeyedContainer()
            for element in value {
                try container.encode(element)
            }
        case .object(let value):
            var container = encoder.container(keyedBy: DynamicCodingKey.self)
            for (key, nestedValue) in value {
                try container.encode(nestedValue, forKey: DynamicCodingKey(key))
            }
        }
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        return nil
    }
}

private final class FileLogSink: @unchecked Sendable {
    private let configuration: FileLoggerConfiguration
    private let fileManager = FileManager.default
    private let queue = DispatchQueue(label: "slicc.file-logger")
    private var fileHandle: FileHandle?
    private var currentDayStamp: String?
    private var currentURL: URL?
    private var isEnabled = true

    init(configuration: FileLoggerConfiguration) {
        self.configuration = configuration
        queue.sync {
            do {
                try self.fileManager.createDirectory(
                    at: configuration.logDirectory,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
                if configuration.cleanup {
                    cleanupOldLogs(in: configuration.logDirectory)
                }
            } catch {
                self.isEnabled = false
                self.writeDiagnostic("[file-logger] Failed to initialize file logging: \(error.localizedDescription)")
            }
        }
    }

    var currentLogFileURL: URL? {
        queue.sync { currentURL }
    }

    func write(_ record: FileLogRecord) {
        queue.sync {
            guard isEnabled else { return }

            do {
                let date = Date()
                try openLogFileIfNeeded(for: date)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let payload = try encoder.encode(record)
                try fileHandle?.write(contentsOf: payload)
                try fileHandle?.write(contentsOf: Data([0x0A]))
            } catch {
                isEnabled = false
                writeDiagnostic("[file-logger] File logging disabled: \(error.localizedDescription)")
                try? fileHandle?.close()
                fileHandle = nil
            }
        }
    }

    func close() {
        queue.sync {
            try? fileHandle?.close()
            fileHandle = nil
        }
    }

    private func openLogFileIfNeeded(for date: Date) throws {
        let dayStamp = dayString(for: date)
        if currentDayStamp == dayStamp, fileHandle != nil {
            return
        }

        try fileHandle?.close()

        let fileURL = configuration.logDirectory.appendingPathComponent("slicc-\(dayStamp).log")
        if !fileManager.fileExists(atPath: fileURL.path) {
            fileManager.createFile(atPath: fileURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }

        let handle = try FileHandle(forWritingTo: fileURL)
        try handle.seekToEnd()
        fileHandle = handle
        currentDayStamp = dayStamp
        currentURL = fileURL
    }

    private func writeDiagnostic(_ message: String) {
        guard let data = (message + "\n").data(using: .utf8) else { return }
        try? FileHandle.standardError.write(contentsOf: data)
    }
}

private func iso8601Timestamp(for date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func dayString(for date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}

private func jsonMetadata(from metadata: Logger.Metadata) -> [String: JSONValue] {
    metadata.mapValues(jsonValue(from:))
}

private func jsonValue(from value: Logger.Metadata.Value) -> JSONValue {
    switch value {
    case .string(let string):
        return .string(stripANSI(string))
    case .stringConvertible(let convertible):
        return .string(stripANSI(String(describing: convertible)))
    case .array(let array):
        return .array(array.map(jsonValue(from:)))
    case .dictionary(let dictionary):
        return .object(dictionary.mapValues(jsonValue(from:)))
    }
}