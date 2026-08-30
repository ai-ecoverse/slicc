import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LeaderJoinUrl")

/// Keeping the leader's join URL current for as long as the leader runs.
///
/// `startLeaderProbe` (in `SliccProcess.swift`) is *discovery*: it stops for
/// good the moment a URL lands. This file is *maintenance* — the tray is
/// minted by the browser, and a tab that reloads or has its tray superseded
/// mints a new one, after which the discovered URL names a tray with no
/// leader on it.
extension SliccProcess {

    /// How often the watch loop re-reads `/api/tray-status`. A local HTTP
    /// round-trip is cheap, so this is about how long another device may
    /// see a superseded join URL — not about load.
    static let leaderJoinUrlWatchInterval: TimeInterval = 60

    /// Re-read the leader's `/api/tray-status` and adopt the join URL it
    /// serves *now*.
    ///
    /// `startLeaderProbe` is a one-shot: it stops the moment `leaderJoinUrl`
    /// is set. But the tray is minted by the browser, not by us, and a tab
    /// that reloads or has its tray superseded mints a new one — after which
    /// the URL we discovered at launch names a tray with no leader on it.
    /// Nothing noticed, so the launcher kept handing that dead URL to
    /// followers and kept advertising it over iCloud, where the other
    /// device's reachability probe correctly reported "not responding".
    ///
    /// Returns the current join URL, or `nil` when the leader could not be
    /// reached (a transient failure and "the tray is gone" are the same
    /// answer here, so a `nil` never clears `leaderJoinUrl` — losing the
    /// browser is `clearLeaderIfNoBrowserRunning`'s job).
    @discardableResult
    func refreshLeaderJoinUrl(
        maxAttempts: Int = 1,
        retryDelay: TimeInterval = 1.5
    ) async -> String? {
        guard let servePort = leaderServePort else { return nil }
        let joinUrl = await trayStatusProbe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:\(servePort)",
            maxAttempts: maxAttempts,
            retryDelay: retryDelay,
            exhaustion: .retryable
        )
        guard let joinUrl, !joinUrl.isEmpty else { return nil }
        // The probe suspended; the browser may have gone away while it ran.
        guard leaderServePort != nil else {
            log.info("refreshLeaderJoinUrl: discarding join URL — browser already gone")
            return nil
        }
        if leaderJoinUrl != joinUrl {
            log.info("refreshLeaderJoinUrl: tray re-minted — adopting the new join URL")
            leaderJoinUrl = joinUrl
        }
        return joinUrl
    }

    /// Poll `refreshLeaderJoinUrl` for as long as the app runs, so a tray
    /// re-minted mid-session propagates to followers and to the iCloud
    /// advertisement within one interval. Idle (no HTTP) while no leader
    /// browser is running: the loop keeps waiting rather than exiting, so a
    /// leader started later is picked up without a restart.
    func startLeaderJoinUrlWatch(
        interval: TimeInterval = SliccProcess.leaderJoinUrlWatchInterval
    ) {
        leaderJoinUrlWatchTask?.cancel()
        leaderJoinUrlWatchTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                // Same weak-capture discipline as `startLeaderProbe`: the
                // strong reference is re-derived on the main actor and never
                // held across a suspension point.
                let state: LeaderWatchState = await MainActor.run { [weak self] in
                    guard let self else { return .ownerGone }
                    return self.leaderServePort == nil ? .idle : .hasLeader
                }
                switch state {
                case .ownerGone: return
                case .idle: continue
                case .hasLeader: await self?.refreshLeaderJoinUrl()
                }
            }
        }
    }

    private enum LeaderWatchState {
        case hasLeader
        case idle
        case ownerGone
    }

    /// Stop the watch loop. Production never needs this (the loop idles for
    /// the life of the app); tests use it so a fast-interval loop does not
    /// outlive the case that started it.
    func stopLeaderJoinUrlWatch() {
        leaderJoinUrlWatchTask?.cancel()
        leaderJoinUrlWatchTask = nil
    }

}
