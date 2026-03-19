import XCTest
@testable import SliccstartCore

final class SliccstartAppBundleBuilderTests: XCTestCase {
  private var rootURL: URL!

  override func setUpWithError() throws {
    rootURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: rootURL)
  }

  func testCreatesMacAppBundleWithExecutableAndInfoPlist() throws {
    let executableURL = rootURL.appendingPathComponent("SliccstartApp")
    try Data("#!/bin/sh\necho sliccstart\n".utf8).write(to: executableURL)

    let bundleURL = try SliccstartAppBundleBuilder().createBundle(
      executableURL: executableURL,
      outputDirectoryURL: rootURL
    )

    XCTAssertEqual(bundleURL.lastPathComponent, "Sliccstart.app")
    XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.appendingPathComponent("Contents/MacOS/SliccstartApp").path))

    let plistURL = bundleURL.appendingPathComponent("Contents/Info.plist")
    let data = try Data(contentsOf: plistURL)
    let plist = try XCTUnwrap(
      PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    )

    XCTAssertEqual(plist["CFBundlePackageType"] as? String, "APPL")
    XCTAssertEqual(plist["CFBundleExecutable"] as? String, "SliccstartApp")
    XCTAssertEqual(plist["CFBundleIdentifier"] as? String, "dev.intent.sliccstart")
    XCTAssertEqual(plist["CFBundleName"] as? String, "Sliccstart")
    XCTAssertEqual(plist["NSPrincipalClass"] as? String, "NSApplication")
  }

  func testReplacesExistingBundleContents() throws {
    let executableURL = rootURL.appendingPathComponent("SliccstartApp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executableURL)

    let builder = SliccstartAppBundleBuilder()
    let bundleURL = try builder.createBundle(executableURL: executableURL, outputDirectoryURL: rootURL)
    let staleFileURL = bundleURL.appendingPathComponent("Contents/Resources/stale.txt")
    try FileManager.default.createDirectory(at: staleFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("stale".utf8).write(to: staleFileURL)

    _ = try builder.createBundle(executableURL: executableURL, outputDirectoryURL: rootURL)

    XCTAssertFalse(FileManager.default.fileExists(atPath: staleFileURL.path))
  }
}