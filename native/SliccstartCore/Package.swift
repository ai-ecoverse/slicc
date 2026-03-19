// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SliccstartCore",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "SliccstartCore", targets: ["SliccstartCore"]),
  ],
  targets: [
    .target(name: "SliccstartCore"),
    .testTarget(name: "SliccstartCoreTests", dependencies: ["SliccstartCore"]),
  ]
)