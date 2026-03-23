// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Sliccstart",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/s1ntoneli/AppUpdater.git", from: "0.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "Sliccstart",
            dependencies: ["AppUpdater"],
            path: "Sliccstart"
        ),
        .testTarget(
            name: "SliccstartTests",
            dependencies: ["Sliccstart"],
            path: "SliccstartTests"
        ),
    ]
)
