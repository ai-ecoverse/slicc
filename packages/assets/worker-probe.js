// Boot-triage probe (`ui/boot/worker-triage.ts`): a deliberately tiny
// worker script served un-hashed from the app root. Its only job is to
// prove that http(s) worker main-script loads work in this browser
// session — a wedged Chrome starts blob workers but leaves this one
// silent (#1982). Loaded as a module worker; keep it module-safe and
// side-effect-free beyond the postMessage.
self.postMessage(1);
