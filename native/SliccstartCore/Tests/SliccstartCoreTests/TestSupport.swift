import Foundation

enum ElectronMarker {
  case appAsar
  case helperApp
  case electronAsarIntegrity
}

enum TestSupport {
  static func makeTemporaryDirectory(prefix: String) throws -> URL {
    try FileManager.default.url(
      for: .itemReplacementDirectory,
      in: .userDomainMask,
      appropriateFor: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
      create: true
    ).appendingPathComponent(prefix, isDirectory: true)
  }

  static func createAppBundle(
    in parentURL: URL,
    name: String,
    bundleIdentifier: String,
    executableName: String? = nil,
    iconName: String = "AppIcon",
    electronMarkers: [ElectronMarker] = [],
    createExecutable: Bool = true,
    extraInfo: [String: Any] = [:]
  ) throws -> URL {
    let bundleURL = parentURL.appendingPathComponent("\(name).app", isDirectory: true)
    let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
    let macOSURL = contentsURL.appendingPathComponent("MacOS", isDirectory: true)
    let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
    let frameworksURL = contentsURL.appendingPathComponent("Frameworks", isDirectory: true)
    let fileManager = FileManager.default

    try fileManager.createDirectory(at: macOSURL, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: resourcesURL, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: frameworksURL, withIntermediateDirectories: true)

    let executable = executableName ?? name
    if createExecutable {
      let executableURL = macOSURL.appendingPathComponent(executable)
      try Data("#!/bin/sh\n".utf8).write(to: executableURL)
    }

    try Data().write(to: resourcesURL.appendingPathComponent("\(iconName).icns"))

    var info: [String: Any] = [
      "CFBundleName": name,
      "CFBundleDisplayName": name,
      "CFBundleIdentifier": bundleIdentifier,
      "CFBundleExecutable": executable,
      "CFBundleIconFile": iconName,
    ]

    if electronMarkers.contains(.electronAsarIntegrity) {
      info["ElectronAsarIntegrity"] = ["Resources/app.asar": ["hash": "abc"]]
    }
    extraInfo.forEach { info[$0.key] = $0.value }

    let plistData = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try plistData.write(to: contentsURL.appendingPathComponent("Info.plist"))

    if electronMarkers.contains(.appAsar) {
      try Data().write(to: resourcesURL.appendingPathComponent("app.asar"))
    }
    if electronMarkers.contains(.helperApp) {
      try fileManager.createDirectory(
        at: frameworksURL.appendingPathComponent("\(name) Helper.app", isDirectory: true),
        withIntermediateDirectories: true
      )
    }

    return bundleURL
  }
}