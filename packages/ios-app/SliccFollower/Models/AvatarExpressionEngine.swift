import Foundation









@MainActor
final class AvatarExpressionEngine {

    
    
    struct Snapshot: Equatable, Sendable {
        var shape = 0.0
        var lidTop = 0.0
        var lidBottom = 0.0
        var brows = AvatarExpression.baseBrows
        var browsVisible = false
        
        
        var pupilScale = 1.0
        
        var blinkScale = 1.0
        
        var leftPupilOffset = AvatarExpression.GazePoint(x: 0, y: 0)
        var rightPupilOffset = AvatarExpression.GazePoint(x: 0, y: 0)
    }

    
    
    
    private enum Aim: Equatable {
        case centered
        case point(AvatarExpression.GazePoint)
    }

    
    
    private(set) var snapshot = Snapshot()

    private let clock: @MainActor () -> TimeInterval
    private let random: @MainActor () -> Double

    private var activity: AvatarExpression.Activity?
    private var frozen = false
    private var reduceMotion = false
    private var blinkEnabled = false
    private var drowseDelay = AvatarExpression.defaultDrowseDelaySeconds

    private var shapeCommitted = 0.0
    private var committing = false
    private var primed = false

    private var glowerUntil: TimeInterval?
    private var scrutinyUntil: TimeInterval?
    private var popUntil: TimeInterval?
    private var awaitingSince: TimeInterval?

    private var lastStep: TimeInterval?
    private var blinkStarts: [TimeInterval?] = [nil, nil]
    private var blinkCommitted = [false, false]
    private var nextIdleBlink: [TimeInterval?] = [nil, nil]
    private var gazeIndex = 0
    private var gazeChangedAt: TimeInterval?

    init(
        clock: @escaping @MainActor () -> TimeInterval = {
            Date().timeIntervalSinceReferenceDate
        },
        random: @escaping @MainActor () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.clock = clock
        self.random = random
    }

    

    
    
    func configure(
        activity: AvatarExpression.Activity?,
        frozen: Bool,
        reduceMotion: Bool,
        blink: Bool,
        drowseDelay: TimeInterval = AvatarExpression.defaultDrowseDelaySeconds
    ) {
        let now = clock()
        if activity != self.activity {
            
            awaitingSince = activity == .awaiting ? now : nil
            gazeChangedAt = nil
        }
        self.activity = activity
        self.frozen = frozen
        self.reduceMotion = reduceMotion
        blinkEnabled = blink
        self.drowseDelay = drowseDelay
        if !primed {
            
            
            shapeCommitted = AvatarExpression.shapeTarget(for: activity)
            snapshot.shape = shapeCommitted
            primed = true
        }
        if reduceMotion || frozen { settle(at: now) }
    }

    

    
    func scrutinize() {
        scrutinyUntil = clock() + AvatarExpression.scrutinySeconds
        if reduceMotion || frozen { settle(at: clock()) }
    }

    
    func glower() {
        glowerUntil = clock() + AvatarExpression.glowerSeconds
        if reduceMotion || frozen { settle(at: clock()) }
    }

    
    
    func wake() {
        let now = clock()
        awaitingSince = now
        guard !reduceMotion, !frozen else {
            settle(at: now)
            return
        }
        popUntil = now + AvatarExpression.popSeconds
        startBlink(at: now)
    }

    
    
    func resetExpression() {
        let now = clock()
        glowerUntil = nil
        scrutinyUntil = nil
        popUntil = nil
        awaitingSince = activity == .awaiting ? now : nil
        blinkStarts = [nil, nil]
        blinkCommitted = [false, false]
        nextIdleBlink = [nil, nil]
        gazeIndex = 0
        gazeChangedAt = nil
        committing = false
        shapeCommitted = AvatarExpression.shapeTarget(for: activity)
        snapshot = Snapshot(shape: shapeCommitted)
        lastStep = now
    }

    

    
    @discardableResult
    func frame(at date: Date) -> Snapshot {
        advance(to: date.timeIntervalSinceReferenceDate)
    }

    
    @discardableResult
    func advance(to time: TimeInterval) -> Snapshot {
        
        
        guard !frozen else { return snapshot }
        guard !reduceMotion else {
            settle(at: time)
            return snapshot
        }
        let dt = min(0.05, max(0, time - (lastStep ?? time)))
        lastStep = time
        integrateShape(at: time, dt: dt)
        integrateLids(at: time, dt: dt)
        integrateBlink(at: time)
        integrateGaze(at: time, dt: dt)
        snapshot.pupilScale = AvatarExpression.popScale(remaining: (popUntil ?? 0) - time)
        snapshot.brows = brows
        snapshot.browsVisible = activity == .thinking
        return snapshot
    }

    private var brows = AvatarExpression.baseBrows

    private func integrateShape(at time: TimeInterval, dt: TimeInterval) {
        let target = AvatarExpression.shapeTarget(for: activity)
        if target != shapeCommitted, !committing {
            
            
            committing = true
            startBlink(at: time)
        }
        snapshot.shape = AvatarExpression.approach(
            current: snapshot.shape, target: shapeCommitted,
            rate: AvatarExpression.shapeEase, dt: dt)
    }

    private func integrateLids(at time: TimeInterval, dt: TimeInterval) {
        snapshot.lidTop = AvatarExpression.approach(
            current: snapshot.lidTop, target: lidTopTarget(at: time),
            rate: AvatarExpression.lidEase, dt: dt)
        snapshot.lidBottom = AvatarExpression.approach(
            current: snapshot.lidBottom, target: lidBottomTarget(at: time),
            rate: AvatarExpression.lidEase, dt: dt)
    }

    private func lidTopTarget(at time: TimeInterval, settled: Bool = false) -> Double {
        let glower = (glowerUntil ?? 0) > time ? AvatarExpression.glowerLid : 0
        guard activity == .awaiting else { return glower }
        let elapsed = awaitingSince.map { time - $0 } ?? 0
        
        let waited =
            settled && elapsed > drowseDelay
            ? drowseDelay + AvatarExpression.drowseRampSeconds
            : elapsed
        return max(glower, AvatarExpression.drowseLid(awaiting: waited, delay: drowseDelay))
    }

    private func lidBottomTarget(at time: TimeInterval) -> Double {
        (scrutinyUntil ?? 0) > time ? AvatarExpression.scrutinyLid : 0
    }

    

    private func startBlink(at time: TimeInterval) {
        blinkStarts = [time, time]
        blinkCommitted = [false, false]
    }

    private func integrateBlink(at time: TimeInterval) {
        scheduleIdleBlinks(at: time)
        var scale = 1.0
        for index in blinkStarts.indices {
            guard let start = blinkStarts[index] else { continue }
            let elapsed = time - start
            if elapsed >= AvatarExpression.blinkApexSeconds, !blinkCommitted[index] {
                blinkCommitted[index] = true
                if index == 0 { commitAtApex() }
            }
            if elapsed > AvatarExpression.blinkApexSeconds + AvatarExpression.blinkOutSeconds {
                blinkStarts[index] = nil
                continue
            }
            
            if index == 0 { scale = blinkScale(elapsed: elapsed) }
        }
        snapshot.blinkScale = scale
    }

    private func blinkScale(elapsed: TimeInterval) -> Double {
        if elapsed <= AvatarExpression.blinkApexSeconds {
            let t = min(1, elapsed / AvatarExpression.blinkInSeconds)
            return AvatarExpression.lerp(1, AvatarExpression.blinkSquish, easeInOut(t))
        }
        let t = min(
            1, (elapsed - AvatarExpression.blinkApexSeconds) / AvatarExpression.blinkOutSeconds)
        return AvatarExpression.lerp(AvatarExpression.blinkSquish, 1, easeInOut(t))
    }

    private func easeInOut(_ progress: Double) -> Double {
        progress * progress * (3 - 2 * progress)
    }

    
    
    private func commitAtApex() {
        if committing {
            shapeCommitted = AvatarExpression.shapeTarget(for: activity)
            snapshot.shape = shapeCommitted
            committing = false
        }
        if activity == .thinking {
            brows = AvatarExpression.recockBrows(previous: brows, random: random)
        }
    }

    private func scheduleIdleBlinks(at time: TimeInterval) {
        let periods = [
            AvatarExpression.blinkPeriodLeftSeconds, AvatarExpression.blinkPeriodRightSeconds,
        ]
        for index in periods.indices {
            guard let due = nextIdleBlink[index] else {
                nextIdleBlink[index] = time + periods[index]
                continue
            }
            guard time >= due else { continue }
            nextIdleBlink[index] = time + periods[index]
            guard blinkEnabled else { continue }
            if blinkStarts[index] == nil {
                blinkStarts[index] = time
                blinkCommitted[index] = false
            }
        }
    }

    

    private func aim(at time: TimeInterval) -> Aim? {
        switch activity {
        case .thinking:
            return .point(
                hop(
                    at: time, targets: AvatarExpression.saccadeTargets,
                    interval: AvatarExpression.saccadeIntervalSeconds))
        case .idle:
            return .point(
                hop(
                    at: time, targets: AvatarExpression.wanderTargets,
                    interval: AvatarExpression.wanderIntervalSeconds))
        case .awaiting:
            
            return .centered
        case .working, nil:
            
            
            return nil
        }
    }

    private func gazeRate() -> Double {
        switch activity {
        case .thinking: AvatarExpression.saccadeEase
        case .idle: AvatarExpression.wanderEase
        default: AvatarExpression.anchorEase
        }
    }

    private func hop(
        at time: TimeInterval, targets: [AvatarExpression.GazePoint], interval: TimeInterval
    ) -> AvatarExpression.GazePoint {
        if let changed = gazeChangedAt, time - changed <= interval {
            return targets[min(gazeIndex, targets.count - 1)]
        }
        gazeChangedAt = time
        gazeIndex = AvatarExpression.nextGazeIndex(
            current: gazeIndex, count: targets.count, random: random)
        return targets[gazeIndex]
    }

    private func integrateGaze(at time: TimeInterval, dt: TimeInterval) {
        guard let aim = aim(at: time) else { return }
        let rate = gazeRate()
        snapshot.leftPupilOffset = ease(
            snapshot.leftPupilOffset, toward: offset(for: aim, eyeX: AvatarExpression.leftEyeX),
            rate: rate, dt: dt)
        snapshot.rightPupilOffset = ease(
            snapshot.rightPupilOffset, toward: offset(for: aim, eyeX: AvatarExpression.rightEyeX),
            rate: rate, dt: dt)
    }

    private func ease(
        _ current: AvatarExpression.GazePoint, toward target: AvatarExpression.GazePoint,
        rate: Double, dt: TimeInterval
    ) -> AvatarExpression.GazePoint {
        .init(
            x: AvatarExpression.approach(current: current.x, target: target.x, rate: rate, dt: dt),
            y: AvatarExpression.approach(current: current.y, target: target.y, rate: rate, dt: dt))
    }

    
    
    
    private func offset(for aim: Aim, eyeX: Double) -> AvatarExpression.GazePoint {
        guard case .point(let target) = aim else { return .init(x: 0, y: 0) }
        let dx = target.x - eyeX
        let dy = target.y - AvatarExpression.eyeCenterY
        let distance = (dx * dx + dy * dy).squareRoot()
        guard distance > 0 else { return .init(x: 0, y: 0) }
        let clamp = min(distance, AvatarExpression.maxOffset)
        return .init(x: dx / distance * clamp, y: dy / distance * clamp)
    }

    

    
    
    private func settle(at time: TimeInterval) {
        guard !frozen else { return }
        shapeCommitted = AvatarExpression.shapeTarget(for: activity)
        committing = false
        brows = AvatarExpression.baseBrows
        snapshot.shape = shapeCommitted
        snapshot.lidTop = lidTopTarget(at: time, settled: true)
        snapshot.lidBottom = lidBottomTarget(at: time)
        snapshot.blinkScale = 1
        snapshot.pupilScale = 1
        snapshot.brows = brows
        snapshot.browsVisible = activity == .thinking
        snapshot.leftPupilOffset = .init(x: 0, y: 0)
        snapshot.rightPupilOffset = .init(x: 0, y: 0)
        lastStep = time
    }
}
