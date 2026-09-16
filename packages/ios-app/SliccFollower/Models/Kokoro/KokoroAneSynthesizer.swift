@preconcurrency import CoreML
import Foundation

struct KokoroAneSynthesizer {

    static func synthesize(
        inputIds: [Int32],
        styleS: [Float],
        styleTimbre: [Float],
        speed: Float = KokoroAneConstants.defaultSpeed,
        store: KokoroAneModelStore
    ) async throws -> KokoroAneSynthesisResult {
        precondition(styleS.count == 128, "style_s must be length 128, got \(styleS.count)")
        precondition(
            styleTimbre.count == 128,
            "style_timbre must be length 128, got \(styleTimbre.count)")

        let tEnc = inputIds.count
        var timings = KokoroAneStageTimings()

        let inputIdsArr = try KokoroAneArrays.int32Array(shape: [1, tEnc], from: inputIds)
        let attnMaskArr = try KokoroAneArrays.attentionMask(length: tEnc)
        let styleSArr = try KokoroAneArrays.float16Array(shape: [1, 128], from: styleS)
        let styleTimbreF32 = try KokoroAneArrays.float32Array(
            shape: [1, 128], from: styleTimbre)
        let styleTimbreF16 = try KokoroAneArrays.float16Array(
            shape: [1, 128], from: styleTimbre)
        let speedArr = try KokoroAneArrays.float16Array(shape: [1], from: [speed])

        let albertModel = try await store.model(for: .albert)
        let albertOut = try await predict(
            stage: .albert, model: albertModel,
            inputs: ["input_ids": inputIdsArr, "attention_mask": attnMaskArr],
            timing: &timings.albert
        )
        let bertDur = try rebuild16(albertOut, key: "bert_dur", stage: .albert)

        let postModel = try await store.model(for: .postAlbert)
        let postOut = try await predict(
            stage: .postAlbert, model: postModel,
            inputs: [
                "bert_dur": bertDur,
                "input_ids": inputIdsArr,
                "style_s": styleSArr,
                "speed": speedArr,
                "attention_mask": attnMaskArr,
            ],
            timing: &timings.postAlbert
        )

        let duration = try outputArray(postOut, key: "duration", stage: .postAlbert)
        let durFloats = KokoroAneArrays.readFloats(duration)
        let predDur = durFloats.map { d -> Int32 in
            let r = Int32(Float(d).rounded())
            return max(r, 1)
        }
        let tA = predDur.reduce(0) { $0 + Int($1) }
        if tA > KokoroAneConstants.maxAcousticFrames {
            throw KokoroAneError.acousticFramesExceedCap(
                have: tA, cap: KokoroAneConstants.maxAcousticFrames)
        }

        let predDurArr = try KokoroAneArrays.int32Array(
            shape: [1, predDur.count], from: predDur)
        let dArr = try rebuild16(postOut, key: "d", stage: .postAlbert)
        let tEnArr = try rebuild16(postOut, key: "t_en", stage: .postAlbert)

        let alignModel = try await store.model(for: .alignment)
        let alignOut = try await predict(
            stage: .alignment, model: alignModel,
            inputs: ["pred_dur": predDurArr, "d": dArr, "t_en": tEnArr],
            timing: &timings.alignment
        )
        let enArr = try rebuild16(alignOut, key: "en", stage: .alignment)
        let asrArr = try rebuild16(alignOut, key: "asr", stage: .alignment)

        let prosodyModel = try await store.model(for: .prosody)
        let prosOut = try await predict(
            stage: .prosody, model: prosodyModel,
            inputs: ["en": enArr, "style_s": styleSArr],
            timing: &timings.prosody
        )

        let f0Raw = try outputArray(prosOut, key: "F0", stage: .prosody)
        let f0Shape = f0Raw.shape.map(\.intValue)
        let nRaw = try outputArray(prosOut, key: "N", stage: .prosody)
        let nShape = nRaw.shape.map(\.intValue)

        let f0F32 = try KokoroAneArrays.float32Array(shape: f0Shape, from: f0Raw)
        let noiseModel = try await store.model(for: .noise)
        let noiseOut = try await predict(
            stage: .noise, model: noiseModel,
            inputs: ["F0_curve": f0F32, "style_timbre": styleTimbreF32],
            timing: &timings.noise
        )

        let f0F16 = try KokoroAneArrays.float16Array(shape: f0Shape, from: f0Raw)
        let nF16 = try KokoroAneArrays.float16Array(shape: nShape, from: nRaw)
        let xs0F16 = try rebuild16(noiseOut, key: "x_source_0", stage: .noise)
        let xs1F16 = try rebuild16(noiseOut, key: "x_source_1", stage: .noise)
        let vocoderModel = try await store.model(for: .vocoder)
        let vocOut = try await predict(
            stage: .vocoder, model: vocoderModel,
            inputs: [
                "asr": asrArr,
                "F0_curve": f0F16,
                "N_pred": nF16,
                "x_source_0": xs0F16,
                "x_source_1": xs1F16,
                "style_timbre": styleTimbreF16,
            ],
            timing: &timings.vocoder
        )

        let xPreF32 = try rebuild32(vocOut, key: "x_pre", stage: .vocoder)
        let tailModel = try await store.model(for: .tail)
        let tailOut = try await predict(
            stage: .tail, model: tailModel,
            inputs: ["x_pre": xPreF32],
            timing: &timings.tail
        )
        let audioArr = try outputArray(tailOut, key: "audio", stage: .tail)
        let samples = KokoroAneArrays.readFloats(audioArr)

        return KokoroAneSynthesisResult(
            samples: samples,
            sampleRate: KokoroAneConstants.sampleRate,
            encoderTokens: tEnc,
            acousticFrames: tA,
            timings: timings
        )
    }

    private static func predict(
        stage: KokoroAneStage,
        model: MLModel,
        inputs: [String: MLMultiArray],
        timing: inout Double
    ) async throws -> MLFeatureProvider {
        let provider = try MLDictionaryFeatureProvider(
            dictionary: inputs.mapValues { MLFeatureValue(multiArray: $0) })
        let start = Date()
        do {
            let out = try await model.prediction(from: provider)
            timing = Date().timeIntervalSince(start) * 1000
            return out
        } catch {
            throw KokoroAneError.predictionFailed(stage: stage.rawValue, underlying: error)
        }
    }

    private static func outputArray(
        _ provider: MLFeatureProvider, key: String, stage: KokoroAneStage
    ) throws -> MLMultiArray {
        guard let value = provider.featureValue(for: key)?.multiArrayValue else {
            throw KokoroAneError.unexpectedOutputShape(
                stage: stage.rawValue, expected: "MLMultiArray for '\(key)'", got: "nil")
        }
        return value
    }

    private static func rebuild16(
        _ provider: MLFeatureProvider, key: String, stage: KokoroAneStage
    ) throws -> MLMultiArray {
        let arr = try outputArray(provider, key: key, stage: stage)
        return try KokoroAneArrays.float16Array(shape: arr.shape.map(\.intValue), from: arr)
    }

    private static func rebuild32(
        _ provider: MLFeatureProvider, key: String, stage: KokoroAneStage
    ) throws -> MLMultiArray {
        let arr = try outputArray(provider, key: key, stage: stage)
        return try KokoroAneArrays.float32Array(shape: arr.shape.map(\.intValue), from: arr)
    }
}
