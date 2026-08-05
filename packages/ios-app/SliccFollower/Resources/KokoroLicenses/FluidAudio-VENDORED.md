# Vendored from FluidAudio (Apache-2.0)

Source : https://github.com/FluidInference/FluidAudio.git
Commit : 56607d90b97de7d95a731200563bf49aa5beef20
Scope : English KokoroAne inference + G2P only (Mandarin path intentionally omitted).
License: Apache-2.0 — see `LICENSE`. Mark changed files with `// Modified by JustR`.

**STATUS: adapted + registered — `xcodebuild` (iOS Simulator) BUILD SUCCEEDED.**
The adaptation below is complete: Mandarin stripped, infra shimmed (`KokoroAneShims.swift`),
loaders repointed at our flat `Models/kokoro/` cache, voice loader reads `voices/<id>.json`,
and `KokoroTTSEngine` (actor) composes the pipeline. Remaining work is on-device verification
(audio/pronunciation) — see change tasks §8.

The synthesis entry point we drive:

```swift
KokoroAneSynthesizer.synthesize(
    inputIds: [Int32], styleS: [Float] /*128*/, styleTimbre: [Float] /*128*/,
    speed: Float, store: KokoroAneModelStore
) async throws -> KokoroAneSynthesisResult   // .audio is [Float] @ 24 kHz
```

---

## Adaptation checklist (mechanical, then device-verify)

### A. Provide/replace 3 small infra symbols (unvendored FluidAudio internals)

- **`AppLogger`** (used in `KokoroAneModelStore`, `G2PModel`, …) → add a tiny shim:
  `struct AppLogger { let log: os.Logger; init(category:){ … } func info/warning/error(_:) }`.
- **`ModelNames.KokoroAne.vocab`** (`KokoroAneModelStore:155`) → replace with our vocab filename
  (`acoustic_vocab.json`), or add a `ModelNames` shim holding that constant.
- **`TtsComputeUnitPreset`** (only in `KokoroAneModelStore.init(preset:)`) → delete that initializer
  (we always use `.default`).

### B. Strip the Mandarin path (English only)

- `KokoroAneModelStore.swift`: delete `mandarinG2P`, `mandarinCustomLexicon`, `mandarinG2PPipeline()`,
  `loadG2pwIfAvailable()`, `setMandarinCustomLexicon()` (lines ~103-104, 201-305) and the
  `mandarinG2P = nil` in `cleanup()`.
- `KokoroAneConstants.swift`: drop the Mandarin constants and the `.mandarin` case of
  `KokoroAneVariant` (keep `.english`); fix the `defaultVoice`/`hasBundleSubdir` switches.

### C. Repoint loading at our S3-provisioned cache (replaces `KokoroAneResourceDownloader`)

Cache root = `Documents/KokoroTTSModel/` (provisioned by `KokoroTTSEngine`). In `KokoroAneModelStore`:

- `loadIfNeeded()` ~129: replace `KokoroAneResourceDownloader.ensureModels(...)` with `…/models/acoustic`
  (the 7 `<stage>.mlmodelc` live there).
- vocab ~155: load `…/vocab/acoustic_vocab.json`.
- `voicePack(_:)` ~189: replace `ensureVoicePack(...)` with `…/voices/<voice>.json`.
- G2P (for `G2PModel`): `…/models/g2p/{G2PEncoder,G2PDecoder}.mlmodelc`; lexicons
  `…/lexicons/{us_gold,gb_gold}.json`.

### D. Voice loader: `.json` instead of `.bin`

`KokoroAneVoicePack.load(from:)` expects the packed `.bin` (upstream shipped only `af_heart`). Our
voices are the full `voices/<id>.json` Kokoro voicepacks. Adapt `load` to parse the JSON into the same
in-memory representation, and the slice accessor to yield `styleS`/`styleTimbre` (each length 128) for
a given token length.

### E. Wire `KokoroTTSEngine` (seam already in place)

Convert `KokoroTTSEngine` `struct` → `actor` (holds a `KokoroAneModelStore`). Then:

- `warmUp()` → `store.loadIfNeeded()` + one dummy `synthesize` (hide ANE compile).
- `synthesize(text:voice:language:speed:)` → English G2P (lexicon-first via `us_gold`/`gb_gold`,
  OOV → CoreML `G2PModel`) → tokens via `KokoroAneVocab` → `store.voicePack(voice)` → style slices →
  `KokoroAneSynthesizer.synthesize(...)` → `result.audio`.
- US vs GB: `language` stays `"en"`; British via a `b*` voice + `gb_gold` lexicon (encoded by
  `VoiceStyle.language`).

### F. Register in `project.pbxproj`

Once it compiles locally, add all `KokoroAne/**` `.swift` to the JustR target (reuse the Python
anchor-insert approach used for `TTSVoiceTypes.swift`; `plutil -lint` after).

### G. Device verification (change tasks §8)

Build device **and** Simulator; download → synth → playback 24 kHz; voices incl. GB + speed; OOV
pronunciation; offline error path.
