import FileProvider
import Foundation
import OSLog
import SliccTrayKit

protocol FileProviderDomainRegistering {
    func add(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void)
    func remove(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void)
    func getDomains(completionHandler: @escaping ([NSFileProviderDomain], Error?) -> Void)
}

struct SystemFileProviderDomainRegistrar: FileProviderDomainRegistering {
    func add(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void
    ) {
        NSFileProviderManager.add(domain, completionHandler: completionHandler)
    }

    func remove(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void
    ) {
        NSFileProviderManager.remove(domain, completionHandler: completionHandler)
    }

    func getDomains(completionHandler: @escaping ([NSFileProviderDomain], Error?) -> Void) {
        NSFileProviderManager.getDomainsWithCompletionHandler(completionHandler)
    }
}

final class FileProviderDomainLifecycle {
    /// The identifier is the domain's identity and must NOT follow the name —
    /// changing it orphans the registered domain and the Files.app location
    /// disappears rather than being renamed.
    static let domainIdentifier = NSFileProviderDomainIdentifier(rawValue: "slicc-vfs")
    /// What Files.app puts under Locations. A domain already registered on a
    /// device keeps the name it was created with until it is re-registered,
    /// so an existing install can read "SLICC" until then.
    static let domainDisplayName = "Sliccy"

    static func makeDomain() -> NSFileProviderDomain {
        NSFileProviderDomain(
            identifier: domainIdentifier,
            displayName: domainDisplayName)
    }

    private static let logger = Logger(
        subsystem: "com.sliccy.follower", category: "FileProviderDomain")
    private static let statusKey = "fileProvider.domainStatus"
    private static let errorKey = "fileProvider.domainError"
    private static let domainsKey = "fileProvider.knownDomains"

    private let registrar: FileProviderDomainRegistering
    private let defaults: UserDefaults?

    init(
        registrar: FileProviderDomainRegistering = SystemFileProviderDomainRegistrar(),
        defaults: UserDefaults? = UserDefaults(suiteName: TrayCredentialStore.appGroupIdentifier)
    ) {
        self.registrar = registrar
        self.defaults = defaults
    }

    func registerIfCredentialsAvailable(_ credentialsAvailable: Bool) {
        guard credentialsAvailable else {
            record(status: "skipped-no-credentials", error: nil)
            return
        }
        record(status: "registering", error: nil)
        Self.logger.info("Registering File Provider domain slicc-vfs")
        let domain = Self.makeDomain()
        // Domains registered before SupportsEnumeration was set can stick at
        // userEnabled=false and never appear in Files Locations. Re-add those.
        registrar.getDomains { [weak self] domains, _ in
            let existing = domains.first { $0.identifier == Self.domainIdentifier }
            let needsReset = existing.map { !$0.userEnabled } ?? false
            if needsReset {
                Self.logger.info("Re-adding disabled File Provider domain slicc-vfs")
                self?.registrar.remove(domain) { _ in
                    self?.addDomain(domain)
                }
            } else {
                self?.addDomain(domain)
            }
        }
    }

    func removeDomain() {
        record(status: "removing", error: nil)
        registrar.remove(Self.makeDomain()) { [weak self] error in
            if let error {
                Self.logger.error(
                    "File Provider domain removal failed: \(error.localizedDescription, privacy: .public)"
                )
                self?.record(status: "remove-failed", error: error)
            } else {
                Self.logger.info("File Provider domain removal succeeded")
                self?.record(status: "remove-succeeded", error: nil)
            }
            self?.refreshKnownDomains()
        }
    }

    private func addDomain(_ domain: NSFileProviderDomain) {
        registrar.add(domain) { [weak self] error in
            if let error {
                Self.logger.error(
                    "File Provider domain registration failed: \(error.localizedDescription, privacy: .public)"
                )
                self?.record(status: "register-failed", error: error)
            } else {
                Self.logger.info("File Provider domain registration succeeded")
                self?.record(status: "register-succeeded", error: nil)
            }
            self?.refreshKnownDomains()
        }
    }

    private func refreshKnownDomains() {
        registrar.getDomains { [weak self] domains, error in
            if let error {
                Self.logger.error(
                    "File Provider getDomains failed: \(error.localizedDescription, privacy: .public)"
                )
                self?.defaults?.set(error.localizedDescription, forKey: Self.errorKey)
                return
            }
            let names = domains.map { domain in
                let enabled = domain.userEnabled ? "on" : "off"
                return "\(domain.identifier.rawValue):\(domain.displayName)[userEnabled=\(enabled)]"
            }
            Self.logger.info(
                "File Provider known domains: \(names.joined(separator: ","), privacy: .public)")
            self?.defaults?.set(names, forKey: Self.domainsKey)
        }
    }

    private func record(status: String, error: Error?) {
        defaults?.set(status, forKey: Self.statusKey)
        if let error {
            defaults?.set(String(describing: error), forKey: Self.errorKey)
        } else {
            defaults?.removeObject(forKey: Self.errorKey)
        }
    }
}
