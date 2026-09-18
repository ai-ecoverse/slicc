// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccTraySession",
    
    
    
    
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(
            name: "SliccTraySession",
            targets: ["SliccTraySession"]
        )
    ],
    targets: [
        .target(
            name: "SliccTraySession",
            path: "Sources/SliccTraySession"
        ),
        .testTarget(
            name: "SliccTraySessionTests",
            dependencies: ["SliccTraySession"],
            path: "Tests/SliccTraySessionTests"
        ),
    ]
)
