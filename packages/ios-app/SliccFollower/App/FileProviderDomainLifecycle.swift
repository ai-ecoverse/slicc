import FileProvider

protocol FileProviderDomainRegistering {
    func add(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void)
    func remove(
        _ domain: NSFileProviderDomain,
        completionHandler: @escaping (Error?) -> Void)
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
}

final class FileProviderDomainLifecycle {
    static let domain = NSFileProviderDomain(
        identifier: NSFileProviderDomainIdentifier(rawValue: "slicc-vfs"),
        displayName: "SLICC")

    private let registrar: FileProviderDomainRegistering

    init(registrar: FileProviderDomainRegistering = SystemFileProviderDomainRegistrar()) {
        self.registrar = registrar
    }

    func registerIfCredentialsAvailable(_ credentialsAvailable: Bool) {
        guard credentialsAvailable else { return }
        registrar.add(Self.domain) { _ in }
    }

    func removeDomain() {
        registrar.remove(Self.domain) { _ in }
    }
}
