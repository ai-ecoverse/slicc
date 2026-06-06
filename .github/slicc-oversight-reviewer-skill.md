# SLICC Oversight Reviewer Skill

## Purpose

This skill identifies recurring "blind spots" in SLICC pull requests based on analysis of 500+ historical PRs. It detects patterns that have historically led to production issues, post-merge hotfixes, or reverts.

## When to Use This Skill

Invoke this skill when reviewing PRs in the ai-ecoverse/slicc repository to check for:

1. **Error path coverage gaps** - Missing timeouts, retries, or error handling
2. **UI state preservation issues** - State loss during DOM rebuilds or navigation
3. **Cross-runtime consistency gaps** - Changes to one runtime without updating others
4. **CDP/Chrome integration edge cases** - Browser automation reliability issues
5. **macOS permissions gaps** - Missing TCC, entitlements, or keychain handling
6. **Test coverage blind spots** - Source changes without corresponding test updates

## Historical Context

This skill is based on analysis of actual SLICC incidents:

- **PR #779**: Missing timeouts on E2B SDK calls → production 500 errors
- **PR #566-568**: UI state reset on cluster changes → data loss
- **PR #565**: Node server endpoint added without Swift server equivalent → API inconsistency
- **PR #361**: Screenshot without `bringToFront` → background tab failures
- **PR #453**: Keychain access without entitlements → macOS permission denial
- **PR #673**: CDP port validation missing → security vulnerability

## Five-Runtime Architecture

SLICC deploys to five distinct runtimes:

1. **Browser (webapp)** - packages/webapp/
2. **Chrome Extension** - packages/chrome-extension/
3. **Node Server** - packages/node-server/
4. **Swift Server (macOS)** - packages/swift-server/
5. **iOS App** - (planned/future)

### Runtime Parity Matrix

Different features apply to different runtimes:

| Feature Domain | Browser | Extension | Node | Swift | iOS |
|----------------|---------|-----------|------|-------|-----|
| VFS/File System | ✓ | ✓ | ✓ | ✓ | ⚠️ |
| Mount Backends (S3/DA) | ✓ | ✓ | ✓ | ✓ | ⚠️ |
| Server Signing | N/A | N/A | ✓ | ✓ | ⚠️ |
| CDP/Browser Control | ✓ | ✓ | ✓ | ✓ | ✗ |
| API Endpoints | N/A | N/A | ✓ | ✓ | ⚠️ |
| Secrets Management | ✓ | ✓ | ✓ | ✓ | ⚠️ |
| Agent/AI Integration | ✓ | ✓ | N/A | N/A | ⚠️ |

**Legend:**
- ✓ = Should be present and consistent
- N/A = Intentionally not applicable
- ⚠️ = Check when iOS implementation exists
- ✗ = Platform limitation (e.g., CDP not available on iOS)

## Detection Rules

### 1. Error Path Coverage Gaps

**Trigger patterns:**
- `fetch()` calls without `signal: AbortSignal.timeout(ms)`
- `Sandbox.create()` or `Sandbox.connect()` without `requestTimeoutMs`
- External API calls without retry logic
- Promise chains without `.catch()` handlers
- Async operations without timeout bounds

**Historical precedent:** PR #779 - Missing timeout on E2B SDK caused production cascade failures

**Remediation:**
- Add explicit timeouts to all external API calls
- Implement exponential backoff for retries
- Ensure all async operations have bounded execution time

### 2. UI State Preservation

**Trigger patterns:**
- `.innerHTML = ` or `replaceChildren()` without state capture
- Navigation/routing changes without state persistence
- Component unmount without cleanup
- Local state updates without sync to storage

**Historical precedent:** PR #566-568 - Cluster state reset on UI rebuild caused user data loss

**Remediation:**
- Capture state before DOM manipulation
- Persist critical state to localStorage/IndexedDB
- Restore state after rebuild

### 3. Cross-Runtime Consistency

**Trigger patterns:**
- Changes to `packages/node-server/` without corresponding `packages/swift-server/` updates
- API endpoint changes in one server without the other
- VFS/mount backend changes in browser without extension sync
- Agent/AI integration changes in browser without extension sync
- Secrets management changes in one runtime without others

**Historical precedent:** PR #565 - Node server endpoint added without Swift equivalent caused API routing failures

**Remediation:**
- Update all applicable runtimes (use parity matrix)
- Document intentional exclusions explicitly
- Add cross-runtime integration tests

### 4. CDP Integration Edge Cases

**Trigger patterns:**
- `captureScreenshot()` without `Page.bringToFront()`
- CDP operations without target validation
- Browser context operations without error handling
- CDP port usage without validation

**Historical precedent:** PR #361 - Screenshot of background tabs failed silently; PR #673 - Unvalidated CDP port

**Remediation:**
- Always call `bringToFront()` before visual operations
- Validate CDP connection before use
- Handle CDP disconnections gracefully
- Validate port numbers and access

### 5. macOS Permissions

**Trigger patterns:**
- Keychain access without `keychain-access-groups` entitlement
- Camera/microphone use without TCC (Transparency, Consent, Control) handling
- File system access without proper sandboxing
- Screen recording without permissions check

**Historical precedent:** PR #453 - Keychain access failed due to missing entitlements

**Remediation:**
- Add required entitlements to Xcode project
- Check TCC status before accessing protected resources
- Provide user-facing permission prompts
- Handle permission denial gracefully

### 6. Test Coverage

**Trigger patterns:**
- New files in `src/` without corresponding `test/` files
- Modified business logic without test updates
- New API endpoints without integration tests
- Bug fixes without regression tests

**Remediation:**
- Add unit tests for new code paths
- Update existing tests for modified behavior
- Add integration tests for cross-component changes
- Add regression tests for bug fixes

## Usage Instructions

### For AI Agents

When reviewing a SLICC PR:

1. **Fetch the PR diff and metadata**
2. **Scan for trigger patterns** from each category
3. **Provide contextual analysis** - don't just pattern match:
   - Is this genuinely problematic in THIS specific case?
   - Does the surrounding code mitigate the risk?
   - Are there intentional design decisions at play?
4. **Cite historical precedents** - reference specific past PRs
5. **Provide actionable remediation** - specific code suggestions
6. **Assess severity**:
   - 🔴 **Critical** - High likelihood of production issue (e.g., missing timeout on critical path)
   - 🟡 **Major** - Could cause issues in specific scenarios (e.g., missing state preservation in edge case)
   - 🔵 **Minor** - Code quality/consistency issue (e.g., test coverage gap for trivial code)

### For Humans

This skill document serves as:
- **Training data** for AI agents reviewing SLICC PRs
- **Reference guide** for manual code reviewers
- **Historical record** of SLICC's recurring pain points
- **Onboarding resource** for new contributors

## Maintenance

### Adding New Patterns

When new recurring issues emerge:

1. Document the incident (PR number, impact, root cause)
2. Add detection pattern to appropriate category
3. Update remediation guidance
4. Consider adding to runtime parity matrix if applicable

### Tuning Detection

If false positives occur:

1. Add nuance to detection rules (e.g., "unless X mitigates Y")
2. Update contextual analysis guidance
3. Document intentional exceptions

## Success Metrics

Track these to measure skill effectiveness:

- **Detection rate**: % of issues caught before merge
- **False positive rate**: % of flagged items that were not issues
- **Prevention rate**: Reduction in post-merge hotfixes/reverts for covered categories
- **Coverage**: % of PRs reviewed vs total PRs

## Related Resources

- [SLICC Architecture Documentation](../docs/)
- [Historical PR Analysis](https://github.com/ai-ecoverse/slicc/pulls?q=is%3Apr+label%3Ahotfix)
- [Runtime Deployment Guide](../docs/deployment.md)
