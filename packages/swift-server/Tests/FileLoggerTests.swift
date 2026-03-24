import Foundation
import Logging
import XCTest
@testable import slicc_server

final class FileLoggerTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    func testCreatesDateBasedLogFileWithJSONLines() throws {
        let logger = FileLogger(label: "test", configuration: .init(
            logDirectory: temporaryDirectory,
            logLevel: .debug,
            cleanup: false
        ))

        logger.log(
            level: .info,
            message: "server started",
            metadata: ["port": .stringConvertible(5710)],
            source: "test-source",
            file: #fileID,
            function: #function,
            line: #line
        )
        logger.close()

        let files = try FileManager.default.contentsOfDirectory(at: temporaryDirectory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        XCTAssertTrue(files[0].lastPathComponent.hasPrefix("slicc-"))
        XCTAssertTrue(files[0].lastPathComponent.hasSuffix(".log"))

        let content = try String(contentsOf: files[0], encoding: .utf8)
        let firstLine = try XCTUnwrap(content.split(separator: "\n").first)
        let data = Data(firstLine.utf8)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(payload["level"] as? String, "info")
        XCTAssertEqual(payload["label"] as? String, "test")
        XCTAssertEqual(payload["message"] as? String, "server started")
        XCTAssertEqual((payload["metadata"] as? [String: String])?["port"], "5710")
    }

    func testFiltersByLogLevelAndStripsANSI() throws {
        let logger = FileLogger(label: "test", configuration: .init(
            logDirectory: temporaryDirectory,
            logLevel: .warning,
            cleanup: false
        ))

        logger.log(level: .info, message: "skip me", metadata: nil, source: "test", file: #fileID, function: #function, line: #line)
        logger.log(level: .warning, message: "\u{001B}[32mkeep me\u{001B}[0m", metadata: nil, source: "test", file: #fileID, function: #function, line: #line)
        logger.close()

        let fileURL = try XCTUnwrap(logger.logFileURL)
        let content = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertFalse(content.contains("skip me"))
        XCTAssertTrue(content.contains("keep me"))
        XCTAssertFalse(content.contains("\u{001B}["))
    }

    func testCleanupOldLogsRemovesExpiredFiles() throws {
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        let oldFile = temporaryDirectory.appendingPathComponent("old.log")
        let recentFile = temporaryDirectory.appendingPathComponent("recent.log")
        try "old".write(to: oldFile, atomically: true, encoding: .utf8)
        try "recent".write(to: recentFile, atomically: true, encoding: .utf8)

        let oldDate = Date().addingTimeInterval(-(8 * 24 * 60 * 60))
        try FileManager.default.setAttributes([.modificationDate: oldDate], ofItemAtPath: oldFile.path)

        cleanupOldLogs(in: temporaryDirectory)

        XCTAssertFalse(FileManager.default.fileExists(atPath: oldFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recentFile.path))
    }
}