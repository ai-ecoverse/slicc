import Foundation

enum DesktopElectronMarker {
  case appAsar
  case helperApp
  case electronAsarIntegrity
}

enum DesktopTestSupport {
  static func createAppBundle(
    in parentURL: URL,
    name: String,
    bundleIdentifier: String,
    executableName: String? = nil,
    electronMarkers: [DesktopElectronMarker] = []
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
    try Data("#!/bin/sh\n".utf8).write(to: macOSURL.appendingPathComponent(executable))
    try Data().write(to: resourcesURL.appendingPathComponent("AppIcon.icns"))

    var info: [String: Any] = [
      "CFBundleName": name,
      "CFBundleDisplayName": name,
      "CFBundleIdentifier": bundleIdentifier,
      "CFBundleExecutable": executable,
      "CFBundleIconFile": "AppIcon",
    ]
    if electronMarkers.contains(.electronAsarIntegrity) {
      info["ElectronAsarIntegrity"] = ["Resources/app.asar": ["hash": "abc"]]
    }

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