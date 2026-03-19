// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Sliccstart",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Sliccstart",
            path: "Sliccstart"
        ),
        .testTarget(
            name: "SliccstartTests",
            dependencies: ["Sliccstart"],
            path: "SliccstartTests"
        ),
    ]
)
