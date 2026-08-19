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
        private var isExpression: Bool { variant.hasSuffix("expression") }
        private var isToolbar: Bool { variant.hasSuffix("toolbar") }
        private var scheme: ColorScheme { isDark ? .dark : .light }

        /// One expression-kit tile: an activity plus an optional transient,
        /// driven on a FROZEN clock so the capture is identical every run.
        private struct ExpressionState {
            let name: String
            let activity: AvatarExpression.Activity
            let fill: Double
            var eyes: SliccAgentAvatarGeometry.EyeState = .open
            var transient: Transient = .none

            enum Transient {
                case none
                case glower
                case scrutiny
                case drowse
            }
        }

        private var expressionStates: [ExpressionState] {
            [
                ExpressionState(name: "idle · wander", activity: .idle, fill: 32),
                ExpressionState(name: "thinking · brows", activity: .thinking, fill: 48),
                ExpressionState(name: "working · tool", activity: .working, fill: 48),
                ExpressionState(name: "awaiting · eye contact", activity: .awaiting, fill: 38),
                ExpressionState(
                    name: "glower · tool failed", activity: .thinking, fill: 48,
                    transient: .glower),
                ExpressionState(
                    name: "scrutiny · typing", activity: .awaiting, fill: 38,
                    transient: .scrutiny),
                ExpressionState(
                    name: "drowse · kept waiting", activity: .awaiting, fill: 38,
                    transient: .drowse),
                ExpressionState(
                    name: "working · 95 fill", activity: .working, fill: 95),
                ExpressionState(
                    name: "static · frozen square", activity: .working, fill: 48,
                    eyes: .static),
            ]
        }

        /// Build and drive an engine to the exact frame this tile should show.
        /// The clock never advances past the pose, so no deadline can expire
        /// between launch and capture.
        private func engine(for state: ExpressionState) -> AvatarExpressionEngine {
            let time = FrozenClock()
            let engine = AvatarExpressionEngine(clock: { time.now }, random: { 0.5 })
            let frozen = state.eyes != .open
            engine.configure(
                activity: state.activity, frozen: frozen, reduceMotion: true, blink: false,
                drowseDelay: 1)
            switch state.transient {
            case .none: break
            case .glower: engine.glower()
            case .scrutiny: engine.scrutinize()
            case .drowse:
                // Past the delay, so the settled cut stands in for the ramp.
                time.now = 100
                engine.advance(to: time.now)
            }
            return engine
        }

        private final class FrozenClock {
            var now: TimeInterval = 0
        }

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
            if isToolbar {
                toolbarBody
            } else if isExpression {
                expressionBody
            } else {
                poseBody
            }
        }

        /// The header's own layout, reproduced leaderlessly: the avatar as a
        /// `.principal` toolbar item at the size `ChatView` gives it. The grid
        /// fixtures cannot stand in for this — they put the tile straight into
        /// a stack, where the eye pair happened to land correctly even while
        /// the toolbar dropped the right eye a half tile and clipped it into
        /// the corner. Every activity is captured, since the expression kit's
        /// animating path is the one that broke.
        private var toolbarBody: some View {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 12) {
                        Text("Toolbar · \(isDark ? "dark" : "light")")
                            .font(.headline)
                            .accessibilityIdentifier("avatar-fixture-toolbar")
                        // The same tiles inline, so one capture holds the
                        // toolbar avatar and its in-stack twin for comparison.
                        HStack(spacing: 12) {
                            ForEach(expressionStates.prefix(4).indices, id: \.self) { index in
                                let state = expressionStates[index]
                                SliccAgentAvatarView(
                                    avatar: headerGeometry(for: state),
                                    expression: engine(for: state)
                                )
                                .frame(width: 36, height: 36)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
                }
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        SliccAgentAvatarView(
                            avatar: headerGeometry(for: expressionStates[0]),
                            expression: engine(for: expressionStates[0])
                        )
                        .frame(width: 36, height: 36)
                    }
                }
            }
            .background(isDark ? Color.black : Color.white)
            .foregroundStyle(isDark ? Color.white : Color.black)
            .environment(\.colorScheme, scheme)
        }

        /// `ChatView.selectedAvatar`'s shape: a 30pt cone tile in a 36pt slot.
        private func headerGeometry(for state: ExpressionState) -> SliccAgentAvatarGeometry {
            SliccAgentAvatarGeometry(
                type: .cone, color: "#B07823", eyes: state.eyes, fill: state.fill,
                blink: false, sideLength: 30, activity: state.activity)
        }

        /// The expression-kit state matrix — the iOS twin of the Storybook
        /// captures the web side puts on the PR.
        private var expressionBody: some View {
            VStack(spacing: 10) {
                Text("Expression · \(isDark ? "dark" : "light")")
                    .font(.headline)
                    .accessibilityIdentifier("avatar-fixture-expression")
                LazyVGrid(
                    columns: [GridItem(.fixed(104)), GridItem(.fixed(104)), GridItem(.fixed(104))],
                    spacing: 8
                ) {
                    ForEach(Array(expressionStates.enumerated()), id: \.offset) { _, state in
                        VStack(spacing: 3) {
                            SliccAgentAvatarView(
                                avatar: SliccAgentAvatarGeometry(
                                    type: .scoop, color: "#8B5CF6", eyes: state.eyes,
                                    fill: state.fill, blink: false, sideLength: 96,
                                    activity: state.activity),
                                expression: engine(for: state))
                            Text(state.name)
                                .font(.system(size: 9))
                                .multilineTextAlignment(.center)
                        }
                    }
                }
                HStack(spacing: 10) {
                    Text("26pt").font(.caption)
                    ForEach(expressionStates.prefix(4).indices, id: \.self) { index in
                        let state = expressionStates[index]
                        SliccAgentAvatarView(
                            avatar: SliccAgentAvatarGeometry(
                                type: .scoop, color: "#8B5CF6", eyes: state.eyes,
                                fill: state.fill, blink: false, sideLength: 26,
                                activity: state.activity),
                            expression: engine(for: state))
                    }
                }
                // The cone crops its eye band harder than the scoop does, so it
                // needs its own row: a scoop-only matrix cannot catch a cone
                // mapping that drifts from `slicc-agent-avatar.ts`.
                Text("cone").font(.caption)
                HStack(spacing: 10) {
                    ForEach(expressionStates.prefix(4).indices, id: \.self) { index in
                        let state = expressionStates[index]
                        VStack(spacing: 3) {
                            SliccAgentAvatarView(
                                avatar: SliccAgentAvatarGeometry(
                                    type: .cone, color: "#B07823", eyes: state.eyes,
                                    fill: state.fill, blink: false, sideLength: 72,
                                    activity: state.activity),
                                expression: engine(for: state))
                            SliccAgentAvatarView(
                                avatar: SliccAgentAvatarGeometry(
                                    type: .cone, color: "#B07823", eyes: state.eyes,
                                    fill: state.fill, blink: false, sideLength: 26,
                                    activity: state.activity),
                                expression: engine(for: state))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(isDark ? Color.black : Color.white)
            .foregroundStyle(isDark ? Color.white : Color.black)
            .environment(\.colorScheme, scheme)
        }

        private var poseBody: some View {
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
