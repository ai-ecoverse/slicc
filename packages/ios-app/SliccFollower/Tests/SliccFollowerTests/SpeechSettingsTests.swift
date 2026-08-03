import AVFoundation
import XCTest

@testable import SliccFollower

final class SpeechSettingsTests: XCTestCase {
    func testVoiceOptionsMatchTheCurrentBaseLanguage() {
        let options = [
            option(id: "en-us", name: "Samantha", language: "en-US"),
            option(id: "en-gb", name: "Daniel", language: "en-GB"),
            option(id: "de-de", name: "Anna", language: "de-DE"),
        ]

        XCTAssertEqual(
            SpeechVoiceOption.matchingCurrentLanguage(options, localeIdentifier: "en-CA")
                .map(\.id),
            ["en-gb", "en-us"])
    }

    func testVoiceOptionsSortHigherQualityVariantsFirstForTheSameName() {
        let options = [
            option(id: "default", name: "Samantha", language: "en-US", rank: 0),
            option(id: "premium", name: "Samantha", language: "en-US", rank: 2),
            option(id: "enhanced", name: "Samantha", language: "en-US", rank: 1),
        ]

        XCTAssertEqual(
            SpeechVoiceOption.matchingCurrentLanguage(options, localeIdentifier: "en-US")
                .map(\.id),
            ["premium", "enhanced", "default"])
    }

    func testQualityLabelsCoverAppleVoiceQualities() {
        XCTAssertEqual(SpeechVoiceOption.qualityLabel(for: .premium), "Premium")
        XCTAssertEqual(SpeechVoiceOption.qualityLabel(for: .enhanced), "Enhanced")
        XCTAssertEqual(SpeechVoiceOption.qualityLabel(for: .default), "Default")
    }

    func testDisplayLabelCombinesNameAndQuality() {
        XCTAssertEqual(
            option(id: "voice", name: "Samantha", language: "en-US", label: "Premium").label,
            "Samantha · Premium")
    }

    func testUnavailableSelectionFallsBackToAutomatic() {
        let options = [option(id: "installed", name: "Samantha", language: "en-US")]

        XCTAssertEqual(SpeechVoiceOption.validSelection("installed", among: options), "installed")
        XCTAssertEqual(SpeechVoiceOption.validSelection("removed", among: options), "")
        XCTAssertEqual(SpeechVoiceOption.validSelection("", among: options), "")
    }

    private func option(
        id: String, name: String, language: String, label: String = "Default", rank: Int = 0
    ) -> SpeechVoiceOption {
        SpeechVoiceOption(
            id: id, name: name, language: language, qualityLabel: label, qualityRank: rank)
    }
}
