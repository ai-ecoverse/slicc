import Foundation
import SliccTraySession
import SliccTrayVFS



final class FileProviderCoordinator {
    static let enabledKey = "fileProvider.finderEnabled"

    private let credentialStore: TrayCredentialStore
    private let domainLifecycle: FileProviderDomainLifecycle
    private let defaults: UserDefaults

    var isEnabled: Bool {
        get { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Self.enabledKey)
            if newValue {
                registerIfCredentialsAvailable()
            } else {
                domainLifecycle.removeDomain()
            }
        }
    }

    init(
        credentialStore: TrayCredentialStore = TrayCredentialStore(),
        domainLifecycle: FileProviderDomainLifecycle = FileProviderDomainLifecycle(),
        defaults: UserDefaults = .standard
    ) {
        self.credentialStore = credentialStore
        self.domainLifecycle = domainLifecycle
        self.defaults = defaults
    }

    
    
    func leaderJoinUrlChanged(_ joinUrl: String?, label: String?) {
        guard let joinUrl, !joinUrl.isEmpty, let url = URL(string: joinUrl) else {
            credentialStore.clear()
            domainLifecycle.removeDomain()
            return
        }
        let trayID = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        _ = credentialStore.save(
            joinURL: url,
            trayID: trayID,
            displayName: label,
            lastConnectedAt: Date())
        registerIfCredentialsAvailable()
    }

    
    func withdrawOnQuit() {
        domainLifecycle.removeDomain()
    }

    private func registerIfCredentialsAvailable() {
        guard isEnabled else {
            domainLifecycle.removeDomain()
            return
        }
        domainLifecycle.registerIfCredentialsAvailable(credentialStore.load() != nil)
    }
}
