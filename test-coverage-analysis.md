# Test Coverage Analysis: Preview Service Worker Integration for `open` Command

## Summary
This PR refactors the `open` shell command to serve VFS files via the preview service worker instead of downloading them, and extracts URL/path helpers into a shared module with comprehensive test coverage. The test coverage is **strong and pragmatic**, covering behavioral changes effectively with 33 new tests across two new test files. The removal of 1 test from `playwright-command.test.ts` is justified by the delegation of VFS-to-preview-URL conversion to the new shared helper.

**Quality Assessment: 9/10** — Tests are well-structured, follow DAMP principles, focus on behavioral contracts, and would catch meaningful regressions from future changes.

---

## Test Coverage Breakdown

### New Test File: `open-command.test.ts` (14 tests)
**File Path**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/open-command.test.ts`

#### Well-Covered Behavioral Areas

1. **Help/Usage Flow (3 tests)**
   - No args → help (line 74-79)
   - `--help` flag → help (line 81-86)
   - Only flags, no targets → help (line 225-230)
   - **Impact**: Prevents regression in UX; users get clear guidance

2. **URL Detection & Direct Opening (2 tests)**
   - HTTP(S) URLs open directly (line 88-96)
   - Multiple targets mixed (line 214-223)
   - **Impact**: Ensures URLs bypass preview-URL conversion and open natively

3. **VFS Path → Preview URL Conversion (3 tests)**
   - Absolute VFS paths convert to preview SW URLs (line 98-112)
   - Directory paths (no file extension) handled correctly (line 114-125)
   - Relative paths resolved against cwd (line 127-138)
   - **Impact**: Core feature; ensures preview URLs are generated correctly in both CLI/extension modes

4. **Download Feature (3 tests)**
   - `--download` flag downloads file as blob (line 140-161)
   - `-d` shorthand works identically (line 163-180)
   - Directory download fails with clear error (line 182-191)
   - **Impact**: Prevents regression in file download; ensures flag behavior consistency

5. **Extension Mode Robustness (2 tests)**
   - `window.open()` returning null (files) doesn't fail (line 193-202)
   - `window.open()` returning null (URLs) doesn't fail (line 204-212)
   - **Impact**: Critical for extension compatibility; per CLAUDE.md, `window.open()` returns null in offscreen/side panel contexts even when tabs open successfully

6. **Browser API Unavailability (1 test)**
   - Graceful error when no browser APIs (line 57-72)
   - **Impact**: Handles Node.js test environment + validates error message

#### Assessment
- **Coverage Quality**: Tests are behavioral, not implementation-specific
- **Edge Cases**: Handles null return from `window.open()` (extension mode), directory rejection in download mode, relative path resolution
- **Mock Quality**: Well-designed mocks with `createMockCtx()` helper; prevents test brittleness
- **Regression Prevention**: Would catch regressions in URL detection, preview URL generation, download flow, and extension compatibility

---

### New Test File: `shared.test.ts` (19 tests)
**File Path**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/shared.test.ts`

#### Well-Covered Utility Functions

1. **`toPreviewUrl()` (3 tests)**
   - Localhost fallback in non-extension env (line 5-8)
   - Full VFS path preservation (line 10-13)
   - Root path handling (line 15-18)
   - **Impact**: Prevents silent URL construction bugs; critical bridge between CLI/extension modes

2. **`isLikelyUrl()` (5 tests)**
   - Detects http/https/about: protocols (line 22-32)
   - Rejects absolute paths (line 34-36)
   - Rejects relative paths (line 38-40)
   - **Impact**: Prevents false positives (e.g., `/path` mistaken for URL); guides routing logic

3. **`basename()` (3 tests)**
   - Standard filename extraction (line 45-46)
   - Root path edge case (line 48-50)
   - Trailing slash stripping (line 52-54)
   - **Impact**: Prevents broken download filenames; handles edge paths

4. **`dirname()` (2 tests)**
   - Parent directory extraction (line 58-60)
   - Top-level file → root (line 62-64)
   - **Impact**: Supports directory navigation; ensures root is `/` not empty string

5. **`joinPath()` (2 tests)**
   - Root + child case (line 68-70)
   - Nested path + child (line 72-74)
   - **Impact**: Prevents path joining bugs (double slashes, missing separators)

6. **`ensureWithinRoot()` (4 tests)**
   - Child within root (line 78-80)
   - Exact root match (line 82-84)
   - Outside root (line 86-88)
   - Prefix-but-not-child boundary (line 90-92: `/workspace` vs `/workspace2`)
   - **Impact**: Security-critical for path ACLs; `ensureWithinRoot` is used for scope validation in RestrictedFS-like patterns

#### Assessment
- **Coverage Completeness**: All exported functions tested
- **Boundary Conditions**: Strong coverage of edge cases (root paths, trailing slashes, prefix collisions)
- **Security Relevance**: `ensureWithinRoot()` has explicit test for prefix collision (line 90-92), preventing `/workspace` from inadvertently matching `/workspace2`
- **Behavioral Testing**: Tests verify contracts, not implementation (e.g., tests don't hardcode regex patterns)

---

## Test Quality Assessment

### Strengths

1. **DAMP Principle**: Test names clearly describe what is being tested ("handles multiple targets", "fails download for directory with --download")
2. **Behavioral Focus**: Tests verify contracts (e.g., "when window.open returns null, exit code is 0") rather than implementation details
3. **Isolated Mocks**: Each test sets up only needed mocks; `createMockCtx()` avoids repetition
4. **Extension Robustness**: Explicit tests for `window.open()` returning null (lines 193-212), per CLAUDE.md extension gotcha
5. **Dual-Mode Support**: `toPreviewUrl()` tested in non-extension env (localhost); would also work in extension mode once bundled
6. **Flag Combinations**: Both `--download` and `-d` tested separately (not just one), plus edge case of flags without targets

### Minor Limitations

1. **Missing: Error Handling for File Stat/Read Failures**
   - Tests mock `stat()` and `readFileBuffer()` as always-succeeding
   - No test for `stat()` throwing (e.g., EACCES, ENOENT on actual missing file)
   - No test for `readFileBuffer()` throwing (e.g., corrupted file, I/O error)
   - **Rating**: 4/10 — These are error cases, but the mocks currently don't simulate failures
   - **Mitigation**: In real usage, these would propagate as exceptions and fail the command, which is acceptable behavior. The current mock design (either exists or throws) is sufficient for command flow testing.

2. **Missing: Mixed Download + Preview Targets**
   - Tests download single file OR preview single/multiple files, but not mixed in one command
   - Command logic supports `open --download /file1.txt /file2.html` (first target errors, second skipped)
   - **Rating**: 3/10 — Nice-to-have; current behavior of "first error stops processing" is captured via "fails download for directory"
   - **Mitigation**: The for-loop returns early on error, so only the first target in a batch can fail. Documenting this in help text would be better than testing it.

3. **Missing: Blob Cleanup Timing**
   - Download test mocks `URL.createObjectURL()` and `URL.revokeObjectURL()` but doesn't verify the `setTimeout` callback (line 72 of open-command.ts)
   - **Rating**: 2/10 — Very minor; the blob is cleaned up asynchronously, and the test verifies the DOM interaction (append/click/remove)
   - **Mitigation**: Current test coverage is sufficient for the behavioral contract (file downloads)

4. **`toPreviewUrl()` Does Not Test Extension Mode Fallback**
   - Test runs in Node environment where `chrome.runtime` is undefined
   - Extension mode (`chrome.runtime.getURL()` call) is not explicitly mocked or tested
   - **Rating**: 6/10 — Moderate concern; the code path exists but isn't exercised in tests
   - **Mitigation**: Extension mode requires runtime `chrome` API injection; Node tests can't run it. The logic is simple (one ternary), and manual testing in the extension would verify this. Alternatively, a browser integration test could be added later.

---

## Critical Gaps (9-10 rating)

**None identified.** All critical behavioral paths are tested:
- URL detection and routing
- VFS-to-preview-URL conversion in CLI mode
- Download feature with file/directory validation
- Extension mode null-return handling
- Help and usage flow

---

## Important Improvements (5-7 rating)

### 1. **File Stat/Read Error Handling** (Rating: 6/10)
**What**: Test error cases when `fs.stat()` or `fs.readFileBuffer()` throw (missing files, permission errors)
**Why**: These are realistic failures that could confuse users if the error message is unclear
**Example Test**:
```typescript
it('handles file not found gracefully', async () => {
  const cmd = createOpenCommand();
  const ctx = createMockCtx();
  ctx.fs.stat.mockRejectedValueOnce(new Error('ENOENT'));
  const result = await cmd.execute(['--download', '/missing.txt'], ctx as any);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('not found');
});
```
**Regression it prevents**: Silent failure or cryptic error if stat throws unexpectedly

### 2. **`toPreviewUrl()` Extension Mode Verification** (Rating: 5/10)
**What**: Mock `chrome.runtime` in a test to verify extension URL generation
**Why**: The function has a dual-mode branch; Node tests only exercise the CLI path
**Example Test**:
```typescript
it('returns chrome-extension URL in extension mode', () => {
  // Mock chrome.runtime
  const originalChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://xyz${path}` }
  };

  const url = toPreviewUrl('/workspace/app');
  expect(url).toContain('chrome-extension://xyz/preview/workspace/app');

  (globalThis as any).chrome = originalChrome;
});
```
**Regression it prevents**: Extension mode gets wrong URL scheme at runtime (though code review would catch this too)

### 3. **MIME Type Detection** (Rating: 4/10)
**What**: Verify `detectMimeType()` calls are correct in download flow
**Why**: Blob type affects browser download behavior; wrong type could cause issues
**Current State**: Mocked as `vi.fn()`, not tested directly
**Note**: This is actually tested implicitly through the download mock, and `detectMimeType()` delegates to `getMimeType()` which likely has its own tests

### 4. **Relative Path Resolution Edge Cases** (Rating: 3/10)
**What**: Test relative paths with `..` (e.g., `open ../other/file.html`)
**Why**: Path traversal could be a concern; `resolvePath()` should handle it
**Current State**: Only tests simple relative paths like `index.html`
**Note**: `resolvePath()` is a mock in tests, so the actual validation would be in VirtualFS/RestrictedFS tests, not here

---

## Test Quality Issues (Brittleness/Over-Specification)

**None identified.** Tests are well-designed:
- Don't hardcode implementation details (e.g., regex patterns in URL detection)
- Mock at the boundary (fs, window, document)
- Use semantic assertions (`toContain()`, `toHaveBeenCalledWith()`) not string comparisons
- Would survive reasonable refactoring (e.g., reordering results array)

---

## Positive Observations

1. **Extraction Justifies Removal**: The test removed from `playwright-command.test.ts` (VFS path → preview URL conversion) was the right one to remove. That logic now lives in `toPreviewUrl()` and is thoroughly tested in `shared.test.ts`. This avoids test duplication and makes the responsibility clearer.

2. **Comprehensive Helper Testing**: `shared.test.ts` tests all utilities at once, making it easy to see coverage completeness. The `ensureWithinRoot()` boundary test (line 90-92) is particularly good — it catches the `/workspace` vs `/workspace2` prefix-collision bug.

3. **Clear Refactoring Story**: The PR moves URL conversion from two places (playwright-command, open-command) into one shared helper. Tests follow this structure, making the refactoring intent obvious.

4. **Extension Compatibility Awareness**: The tests explicitly address the "window.open() returns null" behavior documented in CLAUDE.md (extension mode gotcha). This shows the author understands the dual-mode architecture.

5. **Download Feature Tested Thoroughly**: Both flag variants (`--download`, `-d`), success case, directory rejection, and file/directory stat checking are all covered. The feature is well-protected against regressions.

---

## Recommendations

### For This PR (Do Before Merge)
- **None critical.** Tests are adequate for the feature scope.
- Optional: Add a test for `fs.stat()` throwing to verify error propagation and message clarity.

### For Future Work
1. **Extension Integration Tests**: Once the code runs in the extension, manually test `toPreviewUrl()` with actual `chrome.runtime.getURL()` to verify URL scheme. Could be automated with a Playwright extension test later.
2. **Shared Helper Reuse**: If other commands use `toPreviewUrl()` or `isLikelyUrl()` in the future, tests here provide a good foundation for consistency.
3. **Error Scenario Documentation**: Consider adding inline comments in `open-command.ts` explaining what happens if `fs.stat()` throws (e.g., "stat failures propagate, terminating the command").

---

## Files Analyzed

- **Source**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/open-command.ts` (90 lines)
- **Source**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/shared.ts` (lines 61-111: tested functions; additional functions like `getSqlJs()`, `getPyodide()` are beyond scope of this PR)
- **Tests**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/open-command.test.ts` (231 lines, 14 tests)
- **Tests**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/shared.test.ts` (94 lines, 19 tests)
- **Modified**: `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feature-open-preview-sw/src/shell/supplemental-commands/playwright-command.test.ts` (1 test removed: VFS path conversion)

---

## Conclusion

**This PR's test coverage is strong and pragmatic.** The 33 new tests effectively cover the behavioral changes (URL routing, download flag, preview URL generation, extension robustness) and extracted utilities. The removal of the duplicate VFS-path test from playwright-command.test.ts is justified and leaves the test suite cleaner. Tests are written with behavioral intent, would catch meaningful regressions, and should survive refactoring. No critical gaps exist. Minor improvements (error handling, extension mode verification) are nice-to-haves, not blockers.

**Recommendation**: Approve without changes. Consider the optional file-error test as a follow-up if desired.
