import Foundation
import UIKit
import UserNotifications
import os

enum SliccNotificationCategory: String, CaseIterable {
    case turnEnd = "SLICC_TURN_END"
    case sudoRequest = "SLICC_SUDO_REQUEST"
}

enum SliccNotificationAction: String {

    case sudoDeny = "SLICC_SUDO_DENY"

    case sudoReview = "SLICC_SUDO_REVIEW"
}

enum SliccNotificationKey {
    static let category = "slicc.category"
    static let requestId = "slicc.requestId"
    static let trayId = "slicc.trayId"
}

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

func sliccNotificationPayload(_ userInfo: [AnyHashable: Any]) -> (category: String?, requestId: String?) {
    if let slicc = userInfo["slicc"] as? [String: Any] {
        return (slicc["category"] as? String, slicc["requestId"] as? String)
    }
    return (
        userInfo[SliccNotificationKey.category] as? String,
        userInfo[SliccNotificationKey.requestId] as? String
    )
}

func currentApnsEnvironment() -> String {
    #if DEBUG
        return "sandbox"
    #else
        return "production"
    #endif
}

@MainActor
final class NotificationCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()

    private let logger = Logger(subsystem: "com.slicc.follower", category: "Notifications")

    @Published private(set) var deviceToken: String?

    @Published private(set) var authorized = false

    var onSudoDeny: ((String) -> Void)?
    var onSudoReview: ((String) -> Void)?

    var onDeviceToken: ((String) -> Void)?

    var isActive: () -> Bool = { UIApplication.shared.applicationState == .active }

    private var installed = false

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

    func didRegister(deviceToken data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        onDeviceToken?(hex)
    }

    func didFailToRegister(error: Error) {
        logger.warning("APNs registration failed: \(error.localizedDescription)")
    }

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

    func clearSudoNotification(requestId: String) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["sudo:\(requestId)"])
        center.removeDeliveredNotifications(withIdentifiers: ["sudo:\(requestId)"])

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

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {

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
