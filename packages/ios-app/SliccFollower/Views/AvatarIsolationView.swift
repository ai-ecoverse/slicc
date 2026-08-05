import SwiftUI

#if DEBUG
    /// Leaderless screenshot surface selected by `-uiTestAvatarFixture`.
    struct AvatarIsolationView: View {
        let variant: String

        private struct AvatarState {
            let name: String
            let type: SliccAgentAvatarGeometry.AvatarType
            let color: String
            let eyes: SliccAgentAvatarGeometry.EyeState
            let fill: Double
            let blink: Bool
        }

        private var isDark: Bool { variant.hasPrefix("dark") }
        private var isOffset: Bool { variant.hasSuffix("offset") }
        private var isStatic: Bool { variant.hasSuffix("static") }
        private var scheme: ColorScheme { isDark ? .dark : .light }

        private var states: [AvatarState] {
            if isStatic {
                return [
                    AvatarState(
                        name: "cone · amber · static", type: .cone, color: "#F59E0B",
                        eyes: .static, fill: 92, blink: false)
                ]
            }
            return [
                AvatarState(
                    name: "scoop · violet · 76", type: .scoop, color: "#8B5CF6",
                    eyes: .open, fill: 76, blink: true),
                AvatarState(
                    name: "cone · amber · 32", type: .cone, color: "#F59E0B",
                    eyes: .open, fill: 32, blink: false),
                AvatarState(
                    name: "scoop · orange · dead", type: .scoop, color: "#F97316",
                    eyes: .dead, fill: 84, blink: false),
                AvatarState(
                    name: "scoop · sky · no eyes", type: .scoop, color: "#38BDF8",
                    eyes: .none, fill: 14, blink: false),
            ]
        }

        var body: some View {
            VStack(spacing: 10) {
                Text("Avatar · \(isDark ? "dark" : "light") · \(poseLabel)")
                    .font(.headline)
                    .accessibilityIdentifier(
                        isStatic ? "avatar-fixture-static" : "avatar-fixture")
                LazyVGrid(
                    columns: [GridItem(.fixed(170)), GridItem(.fixed(170))], spacing: 10
                ) {
                    ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                        VStack(spacing: 4) {
                            avatar(for: state, side: 170)
                            Text(state.name).font(.caption2)
                        }
                    }
                }
                HStack(spacing: 14) {
                    Text("26pt").font(.caption)
                    ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                        avatar(for: state, side: 26)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(isDark ? Color.black : Color.white)
            .foregroundStyle(isDark ? Color.white : Color.black)
            .environment(\.colorScheme, scheme)
        }

        private var poseLabel: String {
            if isStatic { return "static" }
            return isOffset ? "offset" : "centered"
        }

        private func avatar(for state: AvatarState, side: Double) -> some View {
            let geometry = SliccAgentAvatarGeometry(
                type: state.type, color: state.color, eyes: state.eyes,
                fill: state.fill, blink: state.blink, sideLength: side)
            let proposedOffset = SliccAgentAvatarGeometry.Point(
                x: isOffset ? side : 0, y: isOffset ? side * 0.45 : 0)
            return SliccAgentAvatarView(avatar: geometry, pupilOffset: proposedOffset)
        }
    }
#endif
