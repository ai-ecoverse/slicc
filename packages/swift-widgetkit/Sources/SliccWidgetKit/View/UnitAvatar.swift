import SwiftUI


















public struct UnitAvatarGeometry: Equatable, Sendable {
    
    public enum EyeState: Equatable, Sendable {
        
        case open
        
        case dead
        
        case none
        
        
        case `static`
    }

    public enum AvatarType: Equatable, Sendable {
        case cone
        case scoop
    }

    public let type: AvatarType
    public let eyes: EyeState
    
    public let face: UnitAvatarFace
    
    
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

    
    var expressionScale: Double { bandUnit }

    

    public var tileCornerRadius: Double { 0.269 * sideLength }

    
    
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

    

    public var eyeRadius: Double { Self.bandEyeRadius * bandUnit }
    public var eyeDiameter: Double { eyeRadius * 2 }
    public var eyeOutlineWidth: Double { Self.bandStrokeWidth * bandUnit }

    public var eyeCenters: [Point] {
        [Self.bandLeftEyeX, Self.bandRightEyeX].map { bandX in
            let placed = placement.place(x: bandX, y: Self.bandEyeCenterY)
            return Point(x: placed.x * sideLength, y: placed.y * sideLength)
        }
    }

    
    
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

    

    
    
    public var socketCornerRadius: Double {
        (Self.bandEyeRadius + (Self.bandSocketMinRx - Self.bandEyeRadius) * face.shape) * bandUnit
    }

    public var pupilCornerRadius: Double {
        pupilRadius + (pupilRadius * Self.pupilMinFraction - pupilRadius) * face.shape
    }

    
    public var lidInset: Double { max(0, min(1, face.lidTop)) * eyeDiameter }

    public var lidIsVisible: Bool { face.lidTop > Self.lidOpenEpsilon }

    
    
    public var lidMaskBleed: Double { eyeOutlineWidth * 2 }
    public var lidLineIsVisible: Bool { face.lidTop > Self.lidLineEpsilon }

    
    
    
    public var chordHalfWidth: Double {
        let y = Self.bandEyeCenterY - Self.bandEyeRadius + face.lidTop * 2 * Self.bandEyeRadius
        let dy = y - Self.bandEyeCenterY
        let round = max(0, Self.bandEyeRadius * Self.bandEyeRadius - dy * dy).squareRoot()
        let squared = Self.bandEyeRadius - 2
        return (round + (squared - round) * face.shape) * bandUnit
    }

    
    
    
    
    var bandTravelClamp: Double {
        let bandPupil = Self.bandPupilRadius * Self.fillToPupilScale(fill)
        return max(2, min(Self.bandMaxGazeOffset, Self.bandEyeRadius - bandPupil - 4))
    }

    
    
    
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

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    public func browCenter(eyeIndex: Int, raise: Double) -> Point {
        let bandX = eyeIndex == 0 ? Self.bandLeftEyeX : Self.bandRightEyeX
        let placed = placement.place(x: bandX, y: Self.browY + raise)
        let halfWidth = browSize.x / 2
        return Point(
            x: min(max(placed.x * sideLength, halfWidth), sideLength - halfWidth),
            y: placed.y * sideLength)
    }

    
    public var browOverhang: Double {
        guard let brows = face.brows else { return 0 }
        let highest = min(
            browCenter(eyeIndex: 0, raise: brows.left.raise).y,
            browCenter(eyeIndex: 1, raise: brows.right.raise).y)
        return max(0, browHalfHeight - highest)
    }

    
    
    
    
    
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

    

    static let noiseCellSize = 1.0
    static let noiseOpacity = 0.72
    static let noiseLuminance = [0.08, 0.36, 0.68, 0.94]
    static let frozenNoiseSeed: UInt32 = 0x51CC_A11E
    static let noiseEyeSalt: UInt32 = 0x85EB_CA6B
}








public struct UnitAvatarFace: Equatable, Sendable {
    public struct BrowPose: Equatable, Sendable {
        public let raise: Double
        public let tilt: Double
    }

    public struct BrowPair: Equatable, Sendable {
        public let left: BrowPose
        public let right: BrowPose
    }

    
    
    public let shape: Double
    
    public let lidTop: Double
    
    public let gaze: UnitAvatarGeometry.Point?
    
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

    
    
    public static let baseBrows = BrowPair(
        left: BrowPose(raise: -9, tilt: -10),
        right: BrowPose(raise: 2, tilt: 6))

    
    
    public static let thinking = UnitAvatarFace(
        shape: 0,
        gaze: UnitAvatarGeometry.Point(x: 95, y: -25),
        brows: baseBrows)

    
    
    
    public static let tool = UnitAvatarFace(shape: 1)

    
    
    public static let awaiting = UnitAvatarFace(shape: 0, lidTop: 0.1)

    
    
    public static let idle = UnitAvatarFace(
        shape: 0, gaze: UnitAvatarGeometry.Point(x: 70, y: 60))

    
    public static let resting = UnitAvatarFace()
}


public struct UnitAvatarView: View {
    public let geometry: UnitAvatarGeometry
    
    
    public let hue: Color
    
    
    public var muted: Bool

    public init(geometry: UnitAvatarGeometry, hue: Color, muted: Bool = false) {
        self.geometry = geometry
        self.hue = hue
        self.muted = muted
    }

    public var body: some View {
        ZStack {
            
            
            
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
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    pupil(index: index)
                        .frame(width: geometry.eyeDiameter, height: geometry.eyeDiameter)
                        .mask(socket)
                }
                socket.stroke(.black, lineWidth: geometry.eyeOutlineWidth)
            }
            
            
            .modifier(LidCut(mask: geometry.lidIsVisible ? lidMask : nil))
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

    
    
    
    
    
    
    
    
    
    private var lidMask: some View {
        let bleed = geometry.lidMaskBleed
        return VStack(spacing: 0) {
            Color.clear.frame(height: geometry.lidInset + bleed)
            Rectangle().fill(.black)
        }
        .frame(
            width: geometry.eyeDiameter + bleed * 2,
            height: geometry.eyeDiameter + bleed * 2)
    }

    
    @ViewBuilder
    private var lidLine: some View {
        if geometry.lidLineIsVisible {
            Capsule()
                .fill(.black)
                .frame(width: geometry.chordHalfWidth * 2, height: geometry.eyeOutlineWidth)
                .position(x: geometry.eyeDiameter / 2, y: geometry.lidInset)
        }
    }

    
    
    
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

    
    
    static func noiseSeed(eyeIndex: Int) -> UInt32 {
        UnitAvatarGeometry.frozenNoiseSeed
            ^ (UInt32(truncatingIfNeeded: eyeIndex) &* UnitAvatarGeometry.noiseEyeSalt)
    }
}





private struct LidCut<Mask: View>: ViewModifier {
    let mask: Mask?

    func body(content: Content) -> some View {
        if let mask {
            content.mask(mask)
        } else {
            content
        }
    }
}


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
    
    
    public var avatarEyes: UnitAvatarGeometry.EyeState {
        switch lifecycle {
        case .broken: .dead
        case .initializing: .none
        case .working, .idle, .unknown: .open
        }
    }

    
    
    
    
    
    
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
