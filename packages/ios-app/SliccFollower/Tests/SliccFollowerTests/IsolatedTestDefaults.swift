import Foundation
import XCTest

/// A `UserDefaults` suite that belongs to one test and nothing else.
///
/// The unit bundle runs serially but in **random order** (`project.yml`'s
/// scheme test action), and each test runs inside the host app's process — so
/// `UserDefaults.standard` there is the installed app's persistent domain:
/// shared by every test in the bundle and written through to disk in the
/// simulator's app container. Two hazards follow from seeding a fixture flag
/// there:
///
/// 1. Order dependence — a test that reads a flag can observe one another test
///    set, and which of the two runs first changes per run.
/// 2. Run-to-run leakage — a flag survives a test that was interrupted before
///    its cleanup (a crash, a cancelled job, the retry `-test-iterations`
///    starts), and the next run reads it. That is how an assertion like "no
///    fixture argument means no backend" fails with nothing wrong in the code.
///
/// An ephemeral suite removes both: nothing is shared, and the teardown block
/// erases the domain even when the test fails part-way through.
extension XCTestCase {
    /// A fresh suite, optionally pre-seeded with fixture flags, erased when
    /// this test ends.
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
