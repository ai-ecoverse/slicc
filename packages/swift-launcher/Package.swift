// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Sliccstart",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/s1ntoneli/AppUpdater.git", from: "2.0.0"),
    ],
    targets: [
        // Keep slicc-server as a separate Swift package; build-app.sh bundles its binary.
        .executableTarget(
            name: "Sliccstart",
            dependencies: ["AppUpdater"],
            path: "Sliccstart",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "SliccstartTests",
            dependencies: ["Sliccstart"],
            path: "SliccstartTests"
        ),
    ]
)
