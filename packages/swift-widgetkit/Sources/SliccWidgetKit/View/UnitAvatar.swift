import SwiftUI

/// The agent avatar — the roundrect tile with the googly eyes — as a widget
/// can draw it, and the ONLY thing on the tile that says what a unit is doing.
///
/// A deliberately STATIC port of `SliccAgentAvatarGeometry` /
/// `SliccAgentAvatarView` / `AvatarExpression` in `packages/ios-app`, which in
/// turn mirror the web's `<slicc-agent-avatar>`. The ratios are the same
/// numbers and the expression grammar is the same grammar; what is gone is the
/// integrator that moves through it. A widget process gets one still frame,
/// no sensors and a hard memory budget — `TimelineView(.animation)` does not
/// animate there — so each phase is rendered at the pose the app's own
/// reduced-motion `settle` would land on, with the gaze aimed at the same
/// target the engine would have hopped to.
///
/// Parity is a manual contract, pinned by `UnitAvatarGeometryTests`. Unifying
/// the two means lifting the geometry out of the follower target into this
/// package — a refactor of shared app code with a coverage-floor consequence
/// for `ios-app`, so it is a decision of its own: see `docs/widgets.md`.
public struct UnitAvatarGeometry: Equatable, Sendable {
    /// How the eyes are drawn.
    public enum EyeState: Equatable, Sendable {
        /// The everyday face, wearing ``UnitAvatarFace``.
        case open
        /// `broken` — X'd out.
        case dead
        /// `initializing` — no eyes yet.
        case none
        /// No signal at all: eyes full of frozen TV static. The app's own
        /// treatment for a feed with nothing behind it.
        case `static`
    }

    public enum AvatarType: Equatable, Sendable {
        case cone
        case scoop
    }

    public let type: AvatarType
    public let eyes: EyeState
    /// The pose the open face holds — the whole phase channel.
    public let face: UnitAvatarFace
    /// Context fullness, 0...100. Drives pupil size and NOTHING else — never a
    /// ring, gauge, badge or number on the tile.
    public let fill: Double?
    public let sideLength: Double

    public init(
        type: AvatarType,
        eyes: EyeState = .open,
        face: UnitAvatarFace = .resting,
        fill: Double? = nil,
        sideLength: Double = 26
    ) {
        self.type = type
        self.eyes = eyes
        self.face = face
        self.fill = fill.map { min(100, max(0, $0)) }
        self.sideLength = max(0, sideLength)
    }

    // MARK: Band constants (the web's 200x100 eye band)

    static let bandEyeRadius = 38.0
    static let bandPupilRadius = 18.0
    static let bandEyeCenterY = 50.0
    static let bandLeftEyeX = 55.0
    static let bandRightEyeX = 145.0
    static let bandStrokeWidth = 4.0
    static let bandSocketMinRx = 10.0
    static let bandMaxGazeOffset = 16.0
    static let pupilMinFraction = 0.22
    static let browHalfWidth = 22.0
    static let browY = 2.0
    static let browStroke = 8.0
    /// Below this a lid parks off the socket entirely; below the second, its
    /// closing line stays hidden (a zero-width line still paints its caps).
    static let lidOpenEpsilon = 0.001
    static let lidLineEpsilon = 0.02

    public struct Point: Equatable, Sendable {
        public let x: Double
        public let y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// Where the 200x100 band lands on the tile, per type. An exhaustive
    /// switch rather than a table, for the reason the app gives: a third type
    /// has to declare its own placement instead of silently inheriting the
    /// scoop's — the bug this shape exists to prevent.
    private struct BandPlacement {
        let left: Double
        let top: Double
        let width: Double
        let height: Double
        let zoom: Double

        var unit: Double { zoom * min(width / 200, height / 100) }

        func place(x bandX: Double, y bandY: Double) -> Point {
            let fit = min(width / 200, height / 100)
            let originX = left + (width - 200 * fit) / 2
            let originY = top + (height - 100 * fit) / 2
            return Point(
                x: zoom * (originX + bandX * fit) + 0.5 - zoom * (left + width / 2),
                y: zoom * (originY + bandY * fit) + 0.5 - zoom * (top + height / 2))
        }
    }

    private var placement: BandPlacement {
        switch type {
        case .scoop: .init(left: 0.15, top: 0.30, width: 0.70, height: 0.45, zoom: 2.65)
        case .cone: .init(left: 0.17, top: -0.185, width: 0.70, height: 0.44, zoom: 3)
        }
    }

    private var bandUnit: Double { placement.unit * sideLength }

    /// Band units → points. Every expression scalar crosses on this one factor.
    var expressionScale: Double { bandUnit }

    // MARK: Tile

    public var tileCornerRadius: Double { 0.269 * sideLength }

    /// The scoop-of-ice-cream blob under the eyes: one ellipse, in the unit's
    /// own hue, sized and placed per type.
    public var blobCenter: Point {
        switch type {
        case .cone: Point(x: 0.5 * sideLength, y: 0.83 * sideLength)
        case .scoop: Point(x: 0.5 * sideLength, y: 0.64 * sideLength)
        }
    }

    public var blobSize: Point {
        switch type {
        case .cone: Point(x: 1.84 * sideLength, y: 0.68 * sideLength)
        case .scoop: Point(x: 1.8 * sideLength, y: 1.45 * sideLength)
        }
    }

    // MARK: Eyes

    public var eyeRadius: Double { Self.bandEyeRadius * bandUnit }
    public var eyeDiameter: Double { eyeRadius * 2 }
    public var eyeOutlineWidth: Double { Self.bandStrokeWidth * bandUnit }

    public var eyeCenters: [Point] {
        [Self.bandLeftEyeX, Self.bandRightEyeX].map { bandX in
            let placed = placement.place(x: bandX, y: Self.bandEyeCenterY)
            return Point(x: placed.x * sideLength, y: placed.y * sideLength)
        }
    }

    /// Pupil size IS the context gauge: flat until half full, then growing to
    /// 2.2x by 85%. Same curve as `AvatarExpression.fillToPupilScale`.
    public static func fillToPupilScale(_ fill: Double?) -> Double {
        guard let fill else { return 1 }
        let clamped = min(100, max(0, fill))
        if clamped <= 50 { return 1 }
        if clamped >= 85 { return 2.2 }
        return 1 + ((clamped - 50) / 35) * 1.2
    }

    public var pupilRadius: Double {
        Self.bandPupilRadius * bandUnit * Self.fillToPupilScale(fill)
    }

    public var highlightRadius: Double { 0.4 * pupilRadius }
    public var highlightOffset: Point {
        Point(x: -0.3 * pupilRadius, y: -0.35 * pupilRadius)
    }

    // MARK: Expression

    /// Socket corner radius for the shape channel. At `shape == 0` the radius
    /// IS half the side, which renders as the circle the avatar has always had.
    public var socketCornerRadius: Double {
        (Self.bandEyeRadius + (Self.bandSocketMinRx - Self.bandEyeRadius) * face.shape) * bandUnit
    }

    public var pupilCornerRadius: Double {
        pupilRadius + (pupilRadius * Self.pupilMinFraction - pupilRadius) * face.shape
    }

    /// How far the top lid has descended into the eye, in points.
    public var lidInset: Double { max(0, min(1, face.lidTop)) * eyeDiameter }

    public var lidIsVisible: Bool { face.lidTop > Self.lidOpenEpsilon }
    public var lidLineIsVisible: Bool { face.lidTop > Self.lidLineEpsilon }

    /// Half-width of the line that closes the socket outline at the lid cut.
    /// It tracks the socket's corner radius, so it stays flush as the eye
    /// squares up.
    public var chordHalfWidth: Double {
        let y = Self.bandEyeCenterY - Self.bandEyeRadius + face.lidTop * 2 * Self.bandEyeRadius
        let dy = y - Self.bandEyeCenterY
        let round = max(0, Self.bandEyeRadius * Self.bandEyeRadius - dy * dy).squareRoot()
        let squared = Self.bandEyeRadius - 2
        return (round + (squared - round) * face.shape) * bandUnit
    }

    /// How far a pupil may travel, in band units. A full context window grows
    /// the pupil past the socket, and at that point there is nowhere to look —
    /// `AvatarExpression.travelClamp`, which is what keeps a 90%-full eye from
    /// shoving its pupil out through the white.
    var bandTravelClamp: Double {
        let bandPupil = Self.bandPupilRadius * Self.fillToPupilScale(fill)
        return max(2, min(Self.bandMaxGazeOffset, Self.bandEyeRadius - bandPupil - 4))
    }

    /// Pupil offset for this eye, aiming both eyes at the face's gaze target.
    /// Normalised then clamped to a CIRCLE even in a square socket, exactly as
    /// the engine does, so the corner room goes unused on every surface.
    public func pupilOffset(eyeIndex: Int) -> Point {
        guard let target = face.gaze else { return Point(x: 0, y: 0) }
        let eyeX = eyeIndex == 0 ? Self.bandLeftEyeX : Self.bandRightEyeX
        let dx = target.x - eyeX
        let dy = target.y - Self.bandEyeCenterY
        let distance = (dx * dx + dy * dy).squareRoot()
        guard distance > 0 else { return Point(x: 0, y: 0) }
        let clamp = min(distance, bandTravelClamp)
        return Point(x: dx / distance * clamp * bandUnit, y: dy / distance * clamp * bandUnit)
    }

    var browHalfHeight: Double { Self.browStroke * bandUnit / 2 }

    /// A brow capsule's centre, in tile points.
    ///
    /// Plain band space for the y, exactly as the app places it — which puts
    /// the brow ABOVE the tile's top edge. It is painted over the crop rather
    /// than inside it, so hosts must leave ``browOverhang`` of slack.
    ///
    /// Squeezing them into the headroom between the tile edge and the socket
    /// was the first attempt, and it failed on glass: at a 0.269 corner radius
    /// the tile has no straight edge that high, so the clamped capsule ran
    /// into the rounded corner and came out as a black wedge sliced off at an
    /// angle. There is no room up there — the answer is not to need any.
    ///
    /// The x IS still clamped, and that is a widget-only departure: the app
    /// lets a brow hang off the side because nothing sits next to an avatar
    /// there, whereas here the next cell is a few points away.
    public func browCenter(eyeIndex: Int, raise: Double) -> Point {
        let bandX = eyeIndex == 0 ? Self.bandLeftEyeX : Self.bandRightEyeX
        let placed = placement.place(x: bandX, y: Self.browY + raise)
        let halfWidth = browSize.x / 2
        return Point(
            x: min(max(placed.x * sideLength, halfWidth), sideLength - halfWidth),
            y: placed.y * sideLength)
    }

    /// How far this face's brows reach above the tile, in points.
    public var browOverhang: Double {
        guard let brows = face.brows else { return 0 }
        let highest = min(
            browCenter(eyeIndex: 0, raise: brows.left.raise).y,
            browCenter(eyeIndex: 1, raise: brows.right.raise).y)
        return max(0, browHalfHeight - highest)
    }

    /// The overhang of the tallest brow ANY face can grow at a given size.
    ///
    /// Hosts reserve this rather than the current face's own overhang, so a
    /// thinking unit does not sit a few points lower than the idle one beside
    /// it just because it grew eyebrows.
    public static func maximumBrowOverhang(sideLength: Double) -> Double {
        [AvatarType.cone, .scoop]
            .map {
                UnitAvatarGeometry(type: $0, face: .thinking, sideLength: sideLength).browOverhang
            }
            .max() ?? 0
    }

    public var browSize: Point {
        Point(x: Self.browHalfWidth * 2 * bandUnit, y: Self.browStroke * bandUnit)
    }

    var deadCrossHalfSpan: Double { eyeRadius * (15.0 / 38.0) }
    var deadCrossLineWidth: Double { eyeOutlineWidth * 2 }

    // MARK: TV static

    static let noiseCellSize = 1.0
    static let noiseOpacity = 0.72
    static let noiseLuminance = [0.08, 0.36, 0.68, 0.94]
    static let frozenNoiseSeed: UInt32 = 0x51CC_A11E
    static let noiseEyeSalt: UInt32 = 0x85EB_CA6B
}

/// One still pose of the expression grammar — the widget's whole phase
/// vocabulary, because a widget has no room for a word and no frames to
/// animate in.
///
/// Every value is the target the app's own integrator eases toward, so a
/// widget avatar is the app's avatar caught mid-thought rather than a second
/// design that happens to look similar.
public struct UnitAvatarFace: Equatable, Sendable {
    public struct BrowPose: Equatable, Sendable {
        public let raise: Double
        public let tilt: Double
    }

    public struct BrowPair: Equatable, Sendable {
        public let left: BrowPose
        public let right: BrowPose
    }

    /// 0 = circle, 1 = rounded square. Only tool work squares the eyes up
    /// (`AvatarExpression.shapeTarget`).
    public let shape: Double
    /// Top lid, as a fraction of the eye's height.
    public let lidTop: Double
    /// Where both eyes look, in band coordinates. `nil` is dead ahead.
    public let gaze: UnitAvatarGeometry.Point?
    /// Brows, when the pose grows them. Only `thinking` does.
    public let brows: BrowPair?

    public init(
        shape: Double = 0,
        lidTop: Double = 0,
        gaze: UnitAvatarGeometry.Point? = nil,
        brows: BrowPair? = nil
    ) {
        self.shape = shape
        self.lidTop = lidTop
        self.gaze = gaze
        self.brows = brows
    }

    /// The pose thinking opens with: left brow raised and quizzical, right
    /// settled (`AvatarExpression.baseBrows`).
    public static let baseBrows = BrowPair(
        left: BrowPose(raise: -9, tilt: -10),
        right: BrowPose(raise: 2, tilt: 6))

    /// Waiting on or streaming from the model: round eyes, brows up, looking
    /// up and away past your shoulder (`AvatarExpression.saccadeTargets`).
    public static let thinking = UnitAvatarFace(
        shape: 0,
        gaze: UnitAvatarGeometry.Point(x: 95, y: -25),
        brows: baseBrows)

    /// A tool call is running: the eyes square up. This is the one channel
    /// `AvatarExpression.shapeTarget` spends, and it is what makes "busy with
    /// the world" readable from a 30pt tile with no word next to it.
    public static let tool = UnitAvatarFace(shape: 1)

    /// The turn ended and the composer is yours: eye contact, soft lid
    /// (`AvatarExpression.drowseStartLid`).
    public static let awaiting = UnitAvatarFace(shape: 0, lidTop: 0.1)

    /// Idle with nothing pending: eyes wandering the lower field, alive and
    /// demanding nothing (`AvatarExpression.wanderTargets`).
    public static let idle = UnitAvatarFace(
        shape: 0, gaze: UnitAvatarGeometry.Point(x: 70, y: 60))

    /// No expression channel at all — the legacy face.
    public static let resting = UnitAvatarFace()
}

/// The avatar tile. The tile crops; the brows paint over it.
public struct UnitAvatarView: View {
    public let geometry: UnitAvatarGeometry
    /// The unit's identity hue (`WidgetUnit.avatarColorHex`), never its
    /// activity colour: the tile says WHO, the face says WHAT.
    public let hue: Color
    /// Dimmed for a unit that is quiet, so a grid reads busy-vs-idle before
    /// any face is resolved.
    public var muted: Bool

    public init(geometry: UnitAvatarGeometry, hue: Color, muted: Bool = false) {
        self.geometry = geometry
        self.hue = hue
        self.muted = muted
    }

    public var body: some View {
        ZStack {
            // ONLY the tile clips. The brows ride over it in band space and
            // overhang the top, exactly as they do in the app — hosts pad by
            // `geometry.browOverhang` rather than slicing them off.
            tile.clipShape(RoundedRectangle(cornerRadius: geometry.tileCornerRadius))
            if let brows = geometry.face.brows, geometry.eyes == .open {
                browLayer(brows)
            }
        }
        .frame(width: geometry.sideLength, height: geometry.sideLength)
        .opacity(muted ? 0.55 : 1)
        .accessibilityHidden(true)
    }

    private var tile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: geometry.tileCornerRadius)
                .fill(hue.opacity(0.18))
            Ellipse()
                .fill(hue)
                .frame(width: geometry.blobSize.x, height: geometry.blobSize.y)
                .position(x: geometry.blobCenter.x, y: geometry.blobCenter.y)
            eyes
        }
        .frame(width: geometry.sideLength, height: geometry.sideLength)
    }

    @ViewBuilder
    private var eyes: some View {
        if geometry.eyes == .none {
            EmptyView()
        } else {
            ZStack {
                ForEach(Array(geometry.eyeCenters.enumerated()), id: \.offset) { index, center in
                    eye(index: index).position(x: center.x, y: center.y)
                }
            }
            .frame(width: geometry.sideLength, height: geometry.sideLength)
        }
    }

    @ViewBuilder
    private func eye(index: Int) -> some View {
        let socket = RoundedRectangle(cornerRadius: geometry.socketCornerRadius)
        ZStack {
            ZStack {
                socket.fill(.white)
                switch geometry.eyes {
                case .static:
                    AvatarStaticNoise(seed: Self.noiseSeed(eyeIndex: index)).clipShape(socket)
                case .dead:
                    cross.rotationEffect(.degrees(45))
                    cross.rotationEffect(.degrees(-45))
                case .open, .none:
                    // Masked to the socket: a nearly-full context window grows
                    // the pupil past the white, and a pupil spilling onto the
                    // tile reads as a rendering fault rather than as alarm.
                    //
                    // The mask has to be laid out in the EYE's box. Masking
                    // `pupil` directly sizes the mask to the PUPIL and centres
                    // it on the un-offset position, so a gazing pupil gets
                    // intersected with a same-size circle beside it — two
                    // overlapping circles, i.e. a cat's eye. Visible on a real
                    // device long before any test noticed.
                    pupil(index: index)
                        .frame(width: geometry.eyeDiameter, height: geometry.eyeDiameter)
                        .mask(socket)
                }
                socket.stroke(.black, lineWidth: geometry.eyeOutlineWidth)
            }
            .mask(lidMask)
            lidLine
        }
        .frame(width: geometry.eyeDiameter, height: geometry.eyeDiameter)
    }

    private func pupil(index: Int) -> some View {
        let offset = geometry.pupilOffset(eyeIndex: index)
        return ZStack {
            RoundedRectangle(cornerRadius: geometry.pupilCornerRadius)
                .fill(.black)
                .frame(width: geometry.pupilRadius * 2, height: geometry.pupilRadius * 2)
            Circle()
                .fill(.white)
                .frame(width: geometry.highlightRadius * 2, height: geometry.highlightRadius * 2)
                .offset(x: geometry.highlightOffset.x, y: geometry.highlightOffset.y)
        }
        .offset(x: offset.x, y: offset.y)
    }

    /// The lid: one rectangular mask offset from the top — the SwiftUI mirror
    /// of the web's clip rect.
    @ViewBuilder
    private var lidMask: some View {
        if geometry.lidIsVisible {
            VStack(spacing: 0) {
                Color.clear.frame(height: geometry.lidInset)
                Rectangle().fill(.black)
            }
            .frame(width: geometry.eyeDiameter, height: geometry.eyeDiameter)
        } else {
            Rectangle().fill(.black)
        }
    }

    /// The straight line that closes the socket outline at the lid cut.
    @ViewBuilder
    private var lidLine: some View {
        if geometry.lidLineIsVisible {
            Capsule()
                .fill(.black)
                .frame(width: geometry.chordHalfWidth * 2, height: geometry.eyeOutlineWidth)
                .position(x: geometry.eyeDiameter / 2, y: geometry.lidInset)
        }
    }

    /// Two capsules painted OUTSIDE the tile's roundrect, the mirror of the
    /// web's `.brow-layer`. Hosts must leave `geometry.browOverhang` of slack
    /// above an avatar rather than clipping it.
    private func browLayer(_ brows: UnitAvatarFace.BrowPair) -> some View {
        ZStack {
            brow(brows.left, eyeIndex: 0)
            brow(brows.right, eyeIndex: 1)
        }
        .frame(width: geometry.sideLength, height: geometry.sideLength)
    }

    private func brow(_ pose: UnitAvatarFace.BrowPose, eyeIndex: Int) -> some View {
        let center = geometry.browCenter(eyeIndex: eyeIndex, raise: pose.raise)
        return Capsule()
            .fill(.black)
            .frame(width: geometry.browSize.x, height: geometry.browSize.y)
            .rotationEffect(.degrees(pose.tilt))
            .position(x: center.x, y: center.y)
    }

    private var cross: some View {
        Capsule()
            .fill(.black)
            .frame(width: geometry.deadCrossHalfSpan * 2.8, height: geometry.deadCrossLineWidth)
    }

    /// Frozen, never time-derived: a widget redraws on WidgetKit's schedule,
    /// and static that reshuffles every few hours reads as a rendering bug.
    static func noiseSeed(eyeIndex: Int) -> UInt32 {
        UnitAvatarGeometry.frozenNoiseSeed
            ^ (UInt32(truncatingIfNeeded: eyeIndex) &* UnitAvatarGeometry.noiseEyeSalt)
    }
}

/// The TV static that fills a signal-less eye.
struct AvatarStaticNoise: View {
    let seed: UInt32

    var body: some View {
        Canvas { context, size in
            let cellSize = UnitAvatarGeometry.noiseCellSize
            var noise = AvatarNoiseGenerator(seed: seed)
            for y in stride(from: 0.0, to: size.height, by: cellSize) {
                for x in stride(from: 0.0, to: size.width, by: cellSize) {
                    let shade = UnitAvatarGeometry.noiseLuminance[
                        Int(noise.next() % UInt32(UnitAvatarGeometry.noiseLuminance.count))]
                    let rect = CGRect(
                        x: x, y: y,
                        width: min(cellSize, size.width - x),
                        height: min(cellSize, size.height - y))
                    context.fill(
                        Path(rect),
                        with: .color(Color(white: shade).opacity(UnitAvatarGeometry.noiseOpacity)))
                }
            }
        }
    }
}

/// xorshift32, the app's generator, so the same seed paints the same static.
struct AvatarNoiseGenerator {
    private var state: UInt32

    init(seed: UInt32) {
        state = seed == 0 ? UnitAvatarGeometry.frozenNoiseSeed : seed
    }

    mutating func next() -> UInt32 {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return state
    }
}

extension WidgetUnit {
    /// The eye treatment this unit's lifecycle earns, mirroring the app's
    /// `ScoopSummary.avatarGeometry`.
    public var avatarEyes: UnitAvatarGeometry.EyeState {
        switch lifecycle {
        case .broken: .dead
        case .initializing: .none
        case .working, .idle, .unknown: .open
        }
    }

    /// The pose that carries this unit's phase. THIS is the widget's status
    /// channel — there is no word next to it to fall back on, which is the
    /// point: four faces beat four labels at 30pt.
    ///
    /// Mirrors `ScoopSummary.avatarActivity`: `broken` and `initializing` keep
    /// their own eye treatments and carry no expression at all.
    public var avatarFace: UnitAvatarFace {
        switch (lifecycle, activity) {
        case (.broken, _), (.initializing, _): .resting
        case (.working, .tool): .tool
        case (.working, _): .thinking
        case (.idle, .awaiting): .awaiting
        case (.idle, _), (.unknown, _): .idle
        }
    }

    public func avatarGeometry(sideLength: Double) -> UnitAvatarGeometry {
        UnitAvatarGeometry(
            type: role == .cone ? .cone : .scoop,
            eyes: avatarEyes,
            face: avatarFace,
            fill: fill,
            sideLength: sideLength)
    }
}
