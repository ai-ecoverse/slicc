import Foundation
import SliccstartCore

private enum BundlerError: LocalizedError {
  case unsupportedArgument(String)

  var errorDescription: String? {
    switch self {
    case .unsupportedArgument(let argument):
      return "Unsupported argument: \(argument)"
    }
  }
}

struct BundlerOptions {
  var configuration = "debug"
  var outputDirectory = "dist"
}

private func parseOptions(arguments: ArraySlice<String>) throws -> BundlerOptions {
  var options = BundlerOptions()
  var iterator = arguments.makeIterator()

  while let argument = iterator.next() {
    switch argument {
    case "--configuration", "-c":
      options.configuration = iterator.next() ?? options.configuration
    case "--output":
      options.outputDirectory = iterator.next() ?? options.outputDirectory
    default:
      throw BundlerError.unsupportedArgument(argument)
    }
  }

  return options
}

private func run(_ executablePath: String, arguments: [String], workingDirectory: URL) throws {
  let process = Process()
  process.currentDirectoryURL = workingDirectory
  process.executableURL = URL(fileURLWithPath: executablePath)
  process.arguments = arguments
  try process.run()
  process.waitUntilExit()

  guard process.terminationStatus == 0 else {
    throw NSError(
      domain: "SliccstartAppBundler",
      code: Int(process.terminationStatus),
      userInfo: [NSLocalizedDescriptionKey: "Command failed: \(executablePath) \(arguments.joined(separator: " "))"]
    )
  }
}

@main
struct SliccstartAppBundlerMain {
  static func main() throws {
    let options = try parseOptions(arguments: CommandLine.arguments.dropFirst())
    let fileManager = FileManager.default
    let packageRootURL = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)

    try run(
      "/usr/bin/xcrun",
      arguments: ["swift", "build", "--product", "SliccstartApp", "-c", options.configuration],
      workingDirectory: packageRootURL
    )

    let executableURL = packageRootURL
      .appendingPathComponent(".build", isDirectory: true)
      .appendingPathComponent(options.configuration, isDirectory: true)
      .appendingPathComponent("SliccstartApp")
    let outputDirectoryURL = packageRootURL.appendingPathComponent(options.outputDirectory, isDirectory: true)
    let bundleURL = try SliccstartAppBundleBuilder().createBundle(
      executableURL: executableURL,
      outputDirectoryURL: outputDirectoryURL
    )

    print(bundleURL.path)
  }
}