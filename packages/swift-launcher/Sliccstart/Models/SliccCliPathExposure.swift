import Foundation
import os

private let pathExposureLog = Logger(
    subsystem: "com.slicc.sliccstart",
    category: "SliccCliPathExposure"
)

enum SliccCliPathExposureResult: Equatable {
    case created
    case alreadyCorrect
    case repointed
    case preservedExisting
    case skippedNonManaged
    case failed
}

struct SliccCliPathExposure {
    private let fileManager: FileManager
    private let homeDirectory: URL
    private let isDirectoryWritable: (String) -> Bool

    init(
        fileManager: FileManager = .default,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        isDirectoryWritable: @escaping (String) -> Bool = FileManager.default.isWritableFile(atPath:)
    ) {
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
        self.isDirectoryWritable = isDirectoryWritable
    }

    @discardableResult
    func expose(_ managedBinary: URL) -> SliccCliPathExposureResult {
        let expectedBinary = managedBinDirectory.appendingPathComponent("slicc").standardizedFileURL
        guard managedBinary.standardizedFileURL == expectedBinary else {
            return .skippedNonManaged
        }

        let pathDirectory = homeDirectory.appendingPathComponent(".local/bin", isDirectory: true)
        let link = pathDirectory.appendingPathComponent("slicc")
        do {
            try fileManager.createDirectory(at: pathDirectory, withIntermediateDirectories: true)
        } catch {
            return failure("could not create \(pathDirectory.path): \(error.localizedDescription)")
        }

        if let destination = try? fileManager.destinationOfSymbolicLink(atPath: link.path) {
            let resolvedDestination = resolve(destination, relativeTo: pathDirectory)
            if resolvedDestination == expectedBinary {
                return .alreadyCorrect
            }
            guard isOwnedManagedBinary(resolvedDestination) else {
                pathExposureLog.info("Preserving existing user symlink at \(link.path, privacy: .public)")
                return .preservedExisting
            }
            guard isDirectoryWritable(pathDirectory.path) else {
                return failure("target directory is not writable: \(pathDirectory.path)")
            }
            do {
                try fileManager.removeItem(at: link)
                try fileManager.createSymbolicLink(at: link, withDestinationURL: expectedBinary)
                pathExposureLog.info("Re-pointed managed slicc CLI link at \(link.path, privacy: .public)")
                return .repointed
            } catch {
                return failure("could not update \(link.path): \(error.localizedDescription)")
            }
        }

        if fileManager.fileExists(atPath: link.path) {
            pathExposureLog.info("Preserving existing user install at \(link.path, privacy: .public)")
            return .preservedExisting
        }
        guard isDirectoryWritable(pathDirectory.path) else {
            return failure("target directory is not writable: \(pathDirectory.path)")
        }
        do {
            try fileManager.createSymbolicLink(at: link, withDestinationURL: expectedBinary)
            pathExposureLog.info("Exposed managed slicc CLI at \(link.path, privacy: .public)")
            return .created
        } catch {
            return failure("could not create \(link.path): \(error.localizedDescription)")
        }
    }

    private var managedRootDirectory: URL {
        homeDirectory
            .appendingPathComponent("Library/Application Support/Sliccstart", isDirectory: true)
            .standardizedFileURL
    }

    private var managedBinDirectory: URL {
        SliccCliLocator.managedBinDirectory(homeDirectory: homeDirectory).standardizedFileURL
    }

    private func resolve(_ destination: String, relativeTo directory: URL) -> URL {
        if destination.hasPrefix("/") {
            return URL(fileURLWithPath: destination).standardizedFileURL
        }
        return directory.appendingPathComponent(destination).standardizedFileURL
    }

    private func isOwnedManagedBinary(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        return url.lastPathComponent == "slicc"
            && path.hasPrefix(managedRootDirectory.path + "/")
    }

    private func failure(_ detail: String) -> SliccCliPathExposureResult {
        pathExposureLog.warning("Could not expose managed slicc CLI on PATH: \(detail, privacy: .public)")
        return .failed
    }
}
