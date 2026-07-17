# Live testing checklist — read this before any CDP live-verification pass

Written after a 2026-07-17/18 session where a live test wrote fake HTML
directly into the user's real `#chat` element to "verify a MutationObserver,"
corrupting their actual view. Never again.

## Before touching the browser

- [ ] **Which browser am I actually driving?** Confirm the CDP port/tab
      belongs to the user's real debug-enabled Chrome (`dev-tools/launch-debug-chrome.bat`,
      port 9222), not some other headless instance whose state has nothing
      to do with what the user is looking at. If unsure, ask.
- [ ] **Which chat/scene am I about to touch?** Real user data, or a
      disposable one? If real, either use a disposable scene instead
      (`dev-tools/create-test-scene.mjs`) or get explicit confirmation the
      specific action is safe (read-only checks are always fine).

## Hard rules — no exceptions

1. **NEVER write directly into `#chat`'s DOM** (`innerHTML =`, `textContent =`,
   `appendChild` of fabricated content, etc.) to "test" something, even on a
   disposable scene. `#chat` is core SillyTavern's real render target — any
   fabricated content risks bleeding into real save/render logic in ways a
   quick test doesn't anticipate. If a test needs fake chat content, build
   it through the real `context.chat[]` array + a real re-render call, or
   test the logic in complete isolation (a scratch `<div>` appended to
   `document.body`, never inside `#sheld`/`#chat`).
2. **Prefer read-only checks first.** Before any click/mutation, run a
   read-only state check and confirm you're looking at what you expect.
3. **One clean repro, not ten variations.** If a live test needs more than
   ~3 attempts to get right, stop and re-derive the navigation sequence
   from scratch (screenshot it) rather than guessing at selectors blind —
   guessing wastes time AND risks landing on the wrong element.
4. **Never assume session state carries over.** A page reload, a new tab,
   or simply time passing can silently change what's on screen. Re-check
   before acting, don't trust a state read from several tool calls ago.

## After any live test that touched real state

- [ ] State plainly what was touched (even read-only navigation), so the
      user isn't surprised by anything on their screen.
- [ ] If anything was mutated, confirm it's either disposable test data or
      trivially reversible (e.g., closing a popup), and say so explicitly.
