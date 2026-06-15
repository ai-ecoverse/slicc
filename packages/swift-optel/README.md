# swift-optel

Swift Operational Telemetry / RUM library for the SLICC iOS and macOS apps. Emits the same checkpoints and JSON wire format as Adobe's [`helix-rum-js`](https://github.com/adobe/helix-rum-js), using the configured app ID as the `referer` hostname.

> OpTel = Operational Telemetry — Adobe's RUM-style operational telemetry; not to be confused with OpenTelemetry (OTel).

## SwiftUI auto-instrumentation

Apply the root modifier once on the top-level view of each `Scene`:

```swift
import SwiftUI
import SwiftOptel

@main
struct MyApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .optelAutoInstrument(appID: "com.example.myapp", rate: "high")
        }
    }
}
```

Then opt in per view / control:

```swift
struct ContentView: View {
    var body: some View {
        VStack {
            OptelButton("Sign in", identifier: "sign-in", context: "Auth") {
                signIn()
            }

            NavigationLink("Profile") { ProfileView() }
                .optelTap(source: "ContentView nav#profile")
        }
        .optelView("Home")
    }
}

func signIn() {
    do {
        try authenticate()
    } catch {
        Optel.reportError(error)
    }
}
```

| Modifier / API                                  | Checkpoint                | Source                                                          |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| `.optelAutoInstrument(appID:rate:globalHooks:)` | `enter` (+ macOS globals) | — (also on `background → active`)                               |
| `.optelView(_:)`                                | `navigate`                | view name                                                       |
| `.optelTap(source:)`                            | `click`                   | caller-supplied                                                 |
| `OptelButton(...)`                              | `click`                   | derived `<context> <element>#<identifier>` via accessibility id |
| `Optel.reportError(_:)`                         | `error`                   | bridged `NSError.domain` + `localizedDescription`               |

On macOS, `.optelAutoInstrument` additionally installs an app-level click
monitor and a key/main-window observer, so `click` and `navigate` beacons fire
automatically with sources derived from `NSAccessibility` (identifier / label
/ role / window title). Pass `globalHooks: false` to opt out — useful in tests
or apps that drive their own beacons.

### Interception surface

macOS auto-instrumentation is now first-class:

- **Global clicks (macOS).** `.optelAutoInstrument` installs an `NSEvent`
  left-mouse-up monitor; every click anywhere in the app emits a `click`
  beacon with a `source` derived from the hit element's accessibility id /
  label / role and the owning window title. The per-view modifiers
  (`.optelTap`, `OptelButton`) are now opt-in refinements for finer-grained
  `source` strings, not the only way to capture clicks.
- **Window-level navigation (macOS).** The same modifier observes
  `NSWindow` key / main-window changes and new-window notifications, emitting
  `navigate` beacons sourced from the window title / identifier. `.optelView`
  remains the way to express per-screen navigation inside a single window.
- **Uncaught errors.** `NSSetUncaughtExceptionHandler` is installed on every
  platform; uncaught `NSException`s emit `error` beacons. Swift `Error`
  values are not exceptions and cannot be intercepted globally — catch them
  at your `do/catch` boundaries and forward to `Optel.reportError(_:)`.

### Known limits

- **iOS / UIKit auto-detection is deferred.** On iOS the only auto-fired
  checkpoint is `enter`; clicks and navigation still need `.optelTap` /
  `OptelButton` / `.optelView`.
- **Foregrounding only.** `enter` re-fires on `background → active`;
  background / suspend / inactive transitions are not mapped to a RUM
  checkpoint.
- **`scenePhase` requires a `Scene` ancestor.** Apply
  `.optelAutoInstrument` inside `WindowGroup` content, not on the `App`.
- **Reconfiguration resets the session.** Mount `.optelAutoInstrument` on
  a stable root view; remounting re-`configure`s `Optel` and starts a fresh
  session.
- **No PII capture.** The click monitor records only the derived
  source / target from accessibility metadata — never field contents or
  typed text.
