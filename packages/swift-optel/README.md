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

| Modifier / API                      | Checkpoint | Source                                                          |
| ----------------------------------- | ---------- | --------------------------------------------------------------- |
| `.optelAutoInstrument(appID:rate:)` | `enter`    | — (also on `background → active`)                               |
| `.optelView(_:)`                    | `navigate` | view name                                                       |
| `.optelTap(source:)`                | `click`    | caller-supplied                                                 |
| `OptelButton(...)`                  | `click`    | derived `<context> <element>#<identifier>` via accessibility id |
| `Optel.reportError(_:)`             | `error`    | bridged `NSError.domain` + `localizedDescription`               |

### Known interception limits

- **Per-view opt-in only.** SwiftUI exposes no global tap / navigation
  interception hook, so each tracked view / control must apply a modifier
  (`.optelView`, `.optelTap`, or use `OptelButton`).
- **Uncaught-error hook is Objective-C only.** Swift `Error` values are not
  exceptions; only `NSException`s reach `NSSetUncaughtExceptionHandler`. Use
  `Optel.reportError(_:)` from your own `catch` blocks for Swift errors.
- **Foregrounding only.** `enter` re-fires on `background → active`;
  background / suspend / inactive transitions are not mapped to a RUM
  checkpoint.
- **`scenePhase` requires a `Scene` ancestor.** Apply
  `.optelAutoInstrument` inside `WindowGroup` content, not on the `App`.
- **Reconfiguration resets the session.** Mount `.optelAutoInstrument` on
  a stable root view; remounting re-`configure`s `Optel` and starts a fresh
  session.
