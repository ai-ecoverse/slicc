import Foundation
import UIKit
import UserNotifications
import os

// MARK: - Notification categories (#2062)
//
// Mirrors `APNS_CATEGORY_IDS` in the tray hub's `apns.ts`: the hub's remote
// pushes and this app's local notifications share one category set so the
// lock-screen actions behave identically whichever path woke the phone.

enum SliccNotificationCategory: String, CaseIterable {
    case turnEnd = "SLICC_TURN_END"
    case sudoRequest = "SLICC_SUDO_REQUEST"
}

enum SliccNotificationAction: String {
    /// Deny from the lock screen — no authentication, no app foregrounding.
    case sudoDeny = "SLICC_SUDO_DENY"
    /// Open the app onto the card (Allow always goes through Face ID in-app).
    case sudoReview = "SLICC_SUDO_REVIEW"
}

/// Keys in `userInfo` (remote: the `slicc` object; local: flattened here).
enum SliccNotificationKey {
    static let category = "slicc.category"
    static let requestId = "slicc.requestId"
    static let trayId = "slicc.trayId"
}

/// Build the category set once; pure so the unit test can assert it.
func makeSliccNotificationCategories() -> Set<UNNotificationCategory> {
    let deny = UNNotificationAction(
        identifier: SliccNotificationAction.sudoDeny.rawValue,
        title: "Deny",
        options: [.destructive])
    let review = UNNotificationAction(
        identifier: SliccNotificationAction.sudoReview.rawValue,
        title: "Review…",
        options: [.foreground])
    let sudo = UNNotificationCategory(
        identifier: SliccNotificationCategory.sudoRequest.rawValue,
        actions: [review, deny],
        intentIdentifiers: [],
        options: [.customDismissAction])
    let turnEnd = UNNotificationCategory(
        identifier: SliccNotificationCategory.turnEnd.rawValue,
        actions: [],
        intentIdentifiers: [],
        options: [])
    return [sudo, turnEnd]
}

/// Pull the SLICC metadata out of a notification's userInfo, whichever path
/// (remote `slicc` object or local flattened keys) produced it.
func sliccNotificationPayload(_ userInfo: [AnyHashable: Any]) -> (category: String?, requestId: String?) {
    if let slicc = userInfo["slicc"] as? [String: Any] {
        return (slicc["category"] as? String, slicc["requestId"] as? String)
    }
    return (
        userInfo[SliccNotificationKey.category] as? String,
        userInfo[SliccNotificationKey.requestId] as? String
    )
}

/// The APNs environment this build talks to. Debug builds are signed with a
/// development profile (sandbox gateway); TestFlight / App Store builds use
/// production. Mirrors what `aps-environment` in the provisioning profile says.
func currentApnsEnvironment() -> String {
    #if DEBUG
        return "sandbox"
    #else
        return "production"
    #endif
}

/// Owns `UNUserNotificationCenter`: permission, categories, the APNs token,
/// local notifications for the in-app paths, and the action callbacks.
@MainActor
final class NotificationCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()

    private let logger = Logger(subsystem: "com.slicc.follower", category: "Notifications")

    /// Hex APNs token once iOS hands it over; `nil` on the simulator / denied.
    @Published private(set) var deviceToken: String?
    /// Whether the user granted alert permission.
    @Published private(set) var authorized = false

    /// Sudo actions from the lock screen; `AppState` wires these.
    var onSudoDeny: ((String) -> Void)?
    var onSudoReview: ((String) -> Void)?
    /// Token arrivals; `AppState` re-registers with the leader.
    var onDeviceToken: ((String) -> Void)?
    /// Whether the app is in the foreground; injected so tests can flip it.
    var isActive: () -> Bool = { UIApplication.shared.applicationState == .active }

    private var installed = false

    /// Install as the center's delegate and register categories. Call at
    /// launch — before any notification can be delivered or acted upon.
    func install() {
        guard !installed else { return }
        installed = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(makeSliccNotificationCategories())
        center.getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                self?.authorized =
                    settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional
            }
        }
    }

    /// Ask for alert permission (incl. time-sensitive) and register for APNs.
    /// Safe to call on every connect; iOS only prompts once.
    func requestAuthorizationAndRegister() {
        let center = UNUserNotificationCenter.current()
        let options: UNAuthorizationOptions = [.alert, .sound, .badge, .timeSensitive]
        center.requestAuthorization(options: options) { [weak self] granted, error in
            Task { @MainActor in
                guard let self else { return }
                self.authorized = granted
                if let error {
                    self.logger.warning("Notification authorization failed: \(error.localizedDescription)")
                }
                guard granted else { return }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// `didRegisterForRemoteNotificationsWithDeviceToken` lands here.
    func didRegister(deviceToken data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        onDeviceToken?(hex)
    }

    func didFailToRegister(error: Error) {
        logger.warning("APNs registration failed: \(error.localizedDescription)")
    }

    // MARK: Local notifications (in-app paths)

    /// A sudo prompt arrived over the data channel while the app is not on
    /// screen: post the same time-sensitive banner the hub would have pushed.
    func notifySudoRequest(requestId: String, label: String, trayId: String?) {
        guard !isActive() else { return }
        let content = UNMutableNotificationContent()
        content.title = "Approval needed"
        content.body = "\(label) is waiting for your approval"
        content.sound = .default
        content.categoryIdentifier = SliccNotificationCategory.sudoRequest.rawValue
        content.interruptionLevel = .timeSensitive
        content.relevanceScore = 1
        content.threadIdentifier = trayId ?? "slicc"
        content.userInfo = [
            SliccNotificationKey.category: "sudo_request",
            SliccNotificationKey.requestId: requestId,
        ]
        schedule(id: "sudo:\(requestId)", content: content)
    }

    /// A turn finished while the app is not on screen.
    func notifyTurnEnd(label: String, trayId: String?) {
        guard !isActive() else { return }
        let content = UNMutableNotificationContent()
        content.title = label
        content.body = "Finished — your turn"
        content.sound = .default
        content.categoryIdentifier = SliccNotificationCategory.turnEnd.rawValue
        content.threadIdentifier = trayId ?? "slicc"
        content.userInfo = [SliccNotificationKey.category: "turn_end"]
        schedule(id: "turn-end:\(trayId ?? "slicc")", content: content)
    }

    /// The prompt was withdrawn or answered: clear its banner wherever it came from.
    func clearSudoNotification(requestId: String) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["sudo:\(requestId)"])
        center.removeDeliveredNotifications(withIdentifiers: ["sudo:\(requestId)"])
        // Remote pushes carry the request id in userInfo, not the identifier.
        center.getDeliveredNotifications { delivered in
            let stale =
                delivered
                .filter { sliccNotificationPayload($0.request.content.userInfo).requestId == requestId }
                .map(\.request.identifier)
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
        }
    }

    private func schedule(id: String, content: UNNotificationContent) {
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self] error in
            if let error {
                self?.logger.warning("Local notification failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // On screen, the card itself is the surface; a banner on top of it is noise.
        let active = await MainActor.run { self.isActive() }
        return active ? [] : [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let payload = sliccNotificationPayload(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        await MainActor.run {
            guard payload.category == "sudo_request", let requestId = payload.requestId else { return }
            switch action {
            case SliccNotificationAction.sudoDeny.rawValue:
                self.onSudoDeny?(requestId)
            case SliccNotificationAction.sudoReview.rawValue, UNNotificationDefaultActionIdentifier:
                self.onSudoReview?(requestId)
            default:
                break
            }
        }
    }
}

/// Minimal app delegate so the APNs token callbacks reach the coordinator.
final class SliccAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Task { @MainActor in NotificationCoordinator.shared.install() }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in NotificationCoordinator.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in NotificationCoordinator.shared.didFailToRegister(error: error) }
    }
}
