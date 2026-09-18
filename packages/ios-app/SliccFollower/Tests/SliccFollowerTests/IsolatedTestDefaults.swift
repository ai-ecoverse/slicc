import Foundation
import XCTest



















extension XCTestCase {
    
    
    func makeIsolatedDefaults(
        flags: [String: Any] = [:],
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> UserDefaults {
        let suiteName = "\(type(of: self)).\(UUID().uuidString)"
        let defaults = try XCTUnwrap(
            UserDefaults(suiteName: suiteName),
            "the ephemeral suite \(suiteName) could not be opened",
            file: file,
            line: line
        )
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        for (key, value) in flags {
            defaults.set(value, forKey: key)
        }
        return defaults
    }
}
