# GA4 Headless Automation — Investigation & Design Report

**Target:** Garage Assistant GA4 (FileMaker Pro 14 **runtime**, class `FMPRO14.0RUNTIME`) in Parallels VM `Win11Manual` on macOS.
**Verdict basis:** PROVEN-here (live probes this session) vs. documented-elsewhere (R1–R4 research) are marked inline. Where they conflict, PROVEN-here wins.
**Code cited:** `/Users/service/GA4Scanner/src/tools/{invoice,grid,vm,helpers,keyboard,paste,ocr,mouse}.ts`, `/Users/service/GA4Scanner/agent/ga4-agent.ps1`, `/Users/service/GA4Scanner/scripts/cursorpos.ps1`, `/Users/service/GA4Scanner/worker.md`.

---

## 1. Executive answer

- **FileMaker exposes NO semantic field surface here. PROVEN.** The invoice layout is 9 anonymous UIA `Pane`/`Window` elements (ValuePattern/TextPattern/InvokePattern all 0) and 70 child HWNDs that are 100% MFC/Codejock chrome (`XTPToolBar×24`, `XTPDockBar×16`, `AfxWnd120u×8` canvas, no per-field EDIT/BUTTON). Fields and portal rows are GDI-painted into the canvas. R1 confirms this is the **general case for all FileMaker desktop versions**, not a runtime artifact. **The brief's preferred "UIA/MSAA/Win32 value read/set" architecture is impossible for FIELDS.** Do not pursue it; do not attempt a FileMaker API (COM/ODBC/Data API are all stripped from the runtime — `REGDB_E_CLASSNOTREG`, ODBC shows only "SQL Server").
- **The one semantic foothold is native DIALOGS/menus, not fields.** OS common dialogs (Open/Save/Print/MessageBox) are real Win32 controls with UIA `InvokePattern`; Codejock menu bars may expose `IAccessible`. A **programmatic `Invoke()` does not route through the gated synthetic-mouse path** — this is the single genuinely untested, potentially high-value spike. FileMaker-*drawn* modals (`Show Custom Dialog`, the Open-Document ring, likely the delete confirm) stay canvas → OCR/keyboard.
- **The mouse is Parallels-gated and must stay Mac-side. PROVEN (07/07).** Guest synthetic mouse (SendInput/SetCursorPos/mouse_event, incl. the existing agent's click) is dead whenever Parallels isn't the frontmost Mac app — backgrounded, headless, and osascript-fronted all failed. `prlctl` has **no** `send-mouse-event`/`send-text`/`type` verb (live `prlctl --help`). ⇒ **The mouse must come from the Mac via cliclick, which requires Mac-unlocked + Parallels-frontmost.** Keyboard, clipboard, screenshot, and `prlctl exec` are NOT gated (work headless / Mac-locked). This is inherent and unfixable on this host (Windows HOME = no RDP host to get an independent input queue).
- **The immediate corruption is already root-caused AND fixed. PROVEN end-to-end.** The "7771/£777,799/duplicated-desc" garbling = the tool injected **bare nav scancodes** (Home=71=KP7, End=79=KP1) which, with guest **NumLock ON** (VMs boot NumLock on → recurring waves), typed digits instead of moving the caret, so the clear never fired and every paste appended. Fixed via `ensureNumLockOff()` (reads `[console]::NumberLock` in session 1, toggles via unambiguous scancode 69, re-verifies, ABORTS if it can't) before every fill; the corrupted line re-entered clean, gate £118.80. **Belt-and-suspenders: switch the nav cluster to `prlctl send-key-event -k` virtual keycodes (Home=97, End=103, Del=107, arrows 98/100/102/104), which are NumLock-immune by construction** (they name dedicated nav keys, not the keypad).
- **Recommended architecture = "E-lite" hybrid.** Keep the working Mac stack as the controller and sole mouse/OCR authority; add a *thin* Windows session-1 co-processor for the three things it does better and that aren't mouse: (1) NumLock-immune VK keyboard, (2) **clipboard read-back verification** (deterministic, Unicode-exact — the biggest single reliability win available), (3) native-dialog UIA `Invoke`. **Do NOT build FlaUI/WinAppDriver/SikuliX** — there is nothing for them to automate (fields have no UIA), and four of the six researched tools sit on the exact empty UIA well already exhausted.
- **Restart-safety = at-least-once + idempotent on the pre-reserved GA4 number N; the SCREEN is truth on restart, the Neon journal is only a hint.** N is minted before any irreversible act (reserve-before-risk), so a crash can always re-find "my draft" deterministically. The one irreversible door (Issue) gets a guarded single-fire with independent post-verify; every uncertainty biases to "don't issue / park the draft."

---

## 2. What FileMaker exposes — live evidence

| Channel | Live result (PROVEN-here) | Meaning |
|---|---|---|
| **UIA** (`.NET UIAutomationClient`, session-1, real draft open) | Window subtree = **9 elements** (7 anonymous `ControlType.Pane` + 2 `Window`). ValuePattern=0, TextPattern=0, InvokePattern=0 across ALL. FocusedElement = the canvas `Afx…` Window, never a field. | **Zero per-field UIA.** No value read, no value set, no invoke. Re-confirmed from the correct interactive session (not a session-0 artifact). |
| **MSAA / IAccessible** | Not directly probed here; UIA's `LegacyIAccessiblePattern` was absent in the probe. | R2: painted canvas exposes no `IAccessible` field objects either. One cheap read-only confirm left (Acc-v2), marginal value. |
| **Win32** (`EnumChildWindows`) | **70 HWNDs**, all chrome: `XTPToolBar×24`, `XTPDockBar×16`, `ScrollBar×12`, `AfxWnd120u×8` (canvas), `Afx…×8`, `msctls_statusbar32×1`, `MDIClient×1`. **No per-field EDIT/BUTTON.** | `WM_GETTEXT`/`WM_SETTEXT` have nothing to target. No handle-based control automation for fields. |
| **COM / ActiveX** | `FMPRO.Application` → `REGDB_E_CLASSNOTREG` (prior). | Runtime doesn't register the automation server (R1/R2: ActiveX exists only in full FileMaker Pro, and even there only *runs scripts* — never reads/sets a field value). |
| **ODBC / Data API / ESS** | Only "SQL Server" driver present; no FileMaker/xDBC; no Data API. | R1: runtime strips ESS, ODBC import, Execute SQL, and Layout mode entirely. No schema/query path. |
| **Clipboard read-back** | **WORKS, Unicode-exact.** Select field (double-click+Ctrl+A) → Ctrl+C → `prlctl exec --current-user … Get-Clipboard` returned `"Air Con Re-Gas - R134a (450g)"` byte-exact (en-dash/parens intact). | The **gold-standard verifier**. R1: this is the documented industry workaround (AHK "Ctrl+C then read clipboard") for custom-drawn text. NOT an input bypass — still needs the field selected via the mouse+key path. |

**Net:** the only channels into a *field* are synthetic keyboard (set) and OCR-or-clipboard-after-select (read). The only channels into *native dialogs* additionally include UIA `Invoke`.

---

## 3. Field-by-field interaction capability matrix

Verdicts are the realistic outcome given §2. **R=read, S=set.** "clip-read" = clipboard read-back after selecting the field (Tier-0). "kbd/paste" = keyboard/clipboard-paste set *after Mac-mouse focus*. "OCR" = Apple Vision host-side.

| Element | UIA R | UIA S | MSAA | Win32 R/S | Clipboard R | Keyboard S | Visual/OCR |
|---|---|---|---|---|---|---|---|
| **Invoice # (header)** | ✗ | ✗ | ✗ | ✗ | ⚠ select+copy risky (header not a normal field) | ✗ (system-assigned) | ✅ primary read — "Invoice: N (Not Issued)" |
| **Customer field / Acc No** | ✗ | ✗ | ✗ | ✗ | ✅ after select | ✅ via attach_customer flow | ✅ ("Auto Generate" = unset) |
| **Registration** | ✗ | ✗ | ✗ | ✗ | ✅ **(use before slow VRM lookup)** | ✅ paste, `vmTypeText` fallback | ✅ w/ glyph-fold (`regKey`) |
| **Description (portal)** | ✗ | ✗ | ✗ | ✗ | ✅ (verified byte-exact) | ✅ select-all→paste | ⚠ OCR misreads long strings |
| **Qty** | ✗ | ✗ | ✗ | ✗ | ✅ | ✅ | ⚠ lone "1" in narrow col → confirm via subtotal |
| **Unit price** | ✗ | ✗ | ✗ | ✗ | ✅ | ✅ | ⚠ confirm via `subTotal==round2(qty×price)` |
| **Totals (net/VAT/gross)** | ✗ | ✗ (computed) | ✗ | ✗ | ⚠ | — (read-only calc) | ✅ + arithmetic gate |
| **Portal row (line)** | ✗ | ✗ | ✗ | ✗ | ✅ per-cell after select | ✅ `enterLinesVerified` (idempotent) | ✅ `readPortalRows` |
| **Customer/vehicle search results** | ✗ | ✗ | ✗ | ✗ | ✗ (list, not field) | navigate by arrows | ✅ OCR the result rows |
| **Issue button** | ✗ | ✗ | ✗ | ✗ | — | — | ✅ locate; **Mac-mouse single-fire** |
| **Stamp (ga4Number → Neon)** | n/a (external) | n/a | n/a | n/a | — | — | — (Neon UPDATE, not GA4) |
| **Confirmation / delete dialogs** | **⚠ MAYBE** (OS `#32770` = real BUTTON + `InvokePattern`; FM-drawn = ✗) | **⚠ MAYBE** (same) | ⚠ maybe | ⚠ if `#32770` | ✗ | ✅ Enter/Esc accelerators (careful) | ✅ OCR (authority) |
| **Modal warnings (MOT-reminder editor, Open-Document)** | ⚠ probe | ⚠ probe | ⚠ | ⚠ | ✗ | ✅ but **never Return on Open-Document** (fires Delete+View → destroys reserved draft) | ✅ OCR to detect+branch |

**Reading the matrix:** every field is **set by keyboard/paste after a Mac-mouse focus click**, and **read by OCR, upgraded to clipboard read-back for high-stakes fields**. Only **native dialogs** may add a non-mouse UIA `Invoke` path — the one place worth a spike.

---

## 4. Why each brief experiment resolves as it does

**Group A — Impossible / already-answered negatives (do not spend time):**
- **Exp: UIA read field / UIA set field / MSAA field / Win32 WM_GETTEXT/WM_SETTEXT / pywinauto bind / FlaUI / WinAppDriver `GetText`/`SendKeys` to a field.** All resolve **NEGATIVE** for the same root cause: the field is GDI-painted, emits no UIA element and no child HWND (§2). R2: UIA-v2, FlaUI, pywinauto-uia, WinAppDriver are thin wrappers over the *same* `UIAutomationCore` provider already exhausted — running them re-asks a question we answered. pywinauto-win32 has no HWND to bind. SikuliX only OCRs pixels (worse than existing Vision) and its input is Java-Robot synthetic mouse = **gated**.
- **Exp: FileMaker COM/ActiveX / ODBC / Data API value access.** NEGATIVE — stripped from runtime (`REGDB_E_CLASSNOTREG`, SQL-Server-only ODBC). R1: even where ActiveX exists it runs scripts, never reads/sets a value.

**Group B — Positive / conditional (worth the work):**
- **Exp: Clipboard read-back verifier.** **POSITIVE, PROVEN.** Select→Ctrl+C→`Get-Clipboard` is Unicode-exact. Promote to production verification tier.
- **Exp: NumLock-immune keying via `-k` virtual keycodes.** **POSITIVE** — R3 confirms `-k 97/103/107/98/100/102/104` are X11/XKB logical keys that NumLock cannot reinterpret; delivery of `-k` proven end-to-end. Retire the `-s 71/79/83` bare-scancode nav path.
- **Exp: Native-dialog UIA `Invoke`.** **CONDITIONAL / UNTESTED — the one real spike.** OS `#32770` dialogs have real BUTTONs + `InvokePattern`; a programmatic invoke bypasses the mouse gate. Must be validated **read-only first** (destructive-dialog memory: wrong button is one activation away). Probe: `EnumWindows` for `#32770` + a BUTTON child when a confirm is up; point UIA at the `XTPToolBar` HWNDs (not the document subtree) to test Codejock `IAccessible`.
- **Exp: schtasks `/it` session-1 launch.** **POSITIVE** — R3 confirms `/it`+`/ru <console-user>` runs in session 1 with the interactive token, password-free while logged on; `schtasks.exe` stdout is captured through `prlctl exec` (unlike `Register-ScheduledTask`). Production precedent already exists ("GA4_PDF_Watcher").

---

## 5. Recommended production architecture (hybrid)

### 5.1 Shape

```
┌───────────────────────────── macOS host (controller, source of truth for mouse) ─────────────────────────────┐
│  Orchestrator (TS)  ── backlog/state machine, Neon journal, reconcile-on-boot                                 │
│  Apple Vision OCR (native/ocr.swift → dist/native/ocr) + grid.ts column calibration + invoice.ts fill/verify  │
│  cliclick  ── THE ONLY MOUSE (focus clicks, Issue click)  [requires Mac-unlocked + Parallels-frontmost]       │
│  prlctl send-key-event  ── KEYBOARD (NumLock-guarded; nav via -k virtual keycodes; -j JSON batch for chords)  │
│  prlctl capture ── screenshots (≥25-box frame-health retry)     pbcopy → shared clipboard → guest Ctrl+V      │
│  prlctl exec --current-user ── session-1 READS (Get-Clipboard, NumLock, GetCursorPos, UIA)                    │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────────────┘
                                                 │ (all channels below are NOT mouse; none are gated)
┌────────────────── Windows session-1 co-processor (thin; keyboard/clipboard/dialog/screenshot only) ───────────┐
│  ga4-agent.ps1 (existing) — TCP :8765 line-JSON  ── keyboard via SendInput VK (NumLock-immune), GDI capture   │
│  clipboard read-back verifier (Get-Clipboard, Unicode-exact)                                                  │
│  native-dialog UIA Invoke (spike) — press OS #32770 buttons without the mouse gate                            │
│  ⨯ NO MOUSE — its SendInput click is gated (proven dead 07/07); mouse stays on the Mac                        │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Hard rule to encode:** the mouse cannot move to Windows. Every "click" (field focus, Issue, dialog button that lacks a UIA `Invoke`) is a cliclick from the Mac, gated behind `assertScreenUnlocked` + Parallels-frontmost + a live **input heartbeat** (§9).

### 5.2 Architecture-option scoring

Criteria from the brief: **Field access** (can it read/set GA4 fields?), **Mouse** (can it click GA4?), **Reliability**, **Deploy on Win HOME/no-admin**, **Maintenance**, **Verification quality**.

| Option | Field R/S | Mouse | Reliability | Deploy (HOME) | Maint. | Verify | Verdict |
|---|---|---|---|---|---|---|---|
| **A. Pure Mac + Parallels (today)** | OCR R / kbd+paste S | ✅ cliclick | Good (post-NumLock fix) | n/a (Mac) | Low | OCR + gate | Solid base; lacks deterministic read-back + dialog invoke |
| **B. AHK agent (UIA-v2/Acc-v2)** | ✗ fields | ✗ gated | — | Trivial (portable) | Low | — | Only useful for the dialog spike; no field payoff |
| **C. Python agent (pywinauto)** | ✗ fields | ✗ gated | — | Py+comtypes install | Med | — | Re-confirms known negatives; skip |
| **D. C# / FlaUI** | ✗ fields | ✗ gated | — | Compiled .NET host | Med | — | **Nothing to automate; do NOT build** |
| **E. Hybrid (Mac mouse+OCR + Win session-1 co-proc)** | OCR+**clip-read** R / **VK-kbd**+paste S | ✅ cliclick (Mac only) | **Best** | Agent already exists (TCP :8765) | Med | **clip read-back + gate + dialog UIA** | **RECOMMENDED (E-lite)** |

**Recommendation: E-lite.** Keep A entirely (mouse, OCR, orchestration). Add only the thin Windows co-processor pieces that are strictly additive and non-mouse: VK keyboard, clipboard read-back verification, native-dialog UIA. **Explicitly do NOT build FlaUI/WinAppDriver/SikuliX/pywinauto** — they target a UIA/HWND field surface that does not exist here; WinAppDriver additionally needs admin-gated Dev Mode + a service + EoL .NET 5 and is a dead project. The co-processor is worth it for *verification determinism and NumLock-immunity*, not for any new field access.

---

## 6. Communication mechanism (Mac ↔ Windows co-processor)

**Pick: local TCP loopback (the agent's existing `TcpListener :8765` line-JSON) for live control; shared-folder file queue as bootstrap/fallback only.**

- **TCP `:8765` (primary).** `ga4-agent.ps1` already implements ping/res/screenshot/move/click/type/key/paste over line-JSON. Gives request/response framing and avoids `prl_fs` consistency hazards. Keyboard/screenshot/foreground paths proven 07/07. **Never route the mouse over it** (its click is gated). Bind to loopback / the Parallels NIC only.
- **Shared folder `C:\Mac\Home` (== `/Users/service`) — fallback/bootstrap.** R3: `prl_fs` is **eventually-consistent, not POSIX-atomic** (Parallels KB 112531/130084 document sync lag). If used for file handoff, use **temp-write → rename → sentinel/checksum → poll-with-retry**; never assume atomic rename or cross-boundary locks. This matches the shipped `ocrScreen`/frame-health retry philosophy.
- **SQLite as the channel: rejected.** Adds a second store competing with the authoritative Neon journal and inherits the same `prl_fs` non-atomicity if placed on the share. Neon remains the durable journal; TCP carries transient commands.

**v1:** TCP for commands + reads; Neon for durable state; shared folder only to stage the agent binary and as a degraded fallback if TCP is down.

---

## 7. Windows agent process model

- **Session 1 only.** The agent must run on `Winsta0\Default`'s input desktop as the console user, or even its (non-gated) keyboard/screenshot won't touch GA4. `prlctl exec --current-user` reads fine but does **not** reliably inject (its `keybd_event` couldn't move NumLock — wrong desktop). So the agent is *launched into* session 1, not run via `--current-user`.
- **Launch: clone the `GA4_PDF_Watcher` precedent.** `schtasks.exe /create /tn "GA4_KbdAgent" /tr "powershell -WindowStyle Hidden -File C:\Mac\Home\GA4Scanner\agent\ga4-agent.ps1" /ru <console-user> /it /rl HIGHEST /sc ONLOGON`. `/it` = InteractiveToken (password-free while the console user is logged on; do **not** use `/np` — that's non-interactive, local-only). `schtasks.exe` stdout is captured through `prlctl exec` (create via `schtasks`, not `Register-ScheduledTask`).
- **Re-launch: `AtLogOn`** (VM reboots boot NumLock-on and drop the session — the agent must self-restart, and `ensureNumLockOff` self-heals each fill).
- **Security:** bind TCP to loopback/Parallels NIC; InteractiveToken (no stored credential); no inbound from outside the host. `HighestAvailable` only for the token, not for network exposure.
- **Single-flight vs human use:** the VM is also used by humans. The agent must (a) hold a single-instance mutex, (b) refuse to act unless GA4 is frontmost and the expected draft header is on screen, and (c) never move the mouse (humans keep the mouse; the Mac controller owns the cliclick). Pause automation if a human takes focus.
- **Clean removal:** `schtasks /delete /tn "GA4_KbdAgent" /f` + kill the powershell; no registry/service residue (Task Scheduler entry only). Falls back cleanly to pure-Mac option A if removed.

---

## 8. Job/result schema + restart-safe invoice state machine

### 8.1 Job JSON (input) — matches the brief's shape

```json
{
  "jobId": "web-88231",
  "reservedNumber": 90731,
  "sourceDocId": "WEB-88231",
  "vehicle":  { "registration": "LT19 DHD", "mileage": 61240 },
  "customer": { "surname": "Frankl", "accountNumber": "FRA004" },
  "lines": [
    { "description": "Air Con Re-Gas - R134a (450g)", "qty": 1, "unitPrice": 99.00, "subTotal": 99.00 },
    { "description": "MOT Test", "qty": 1, "unitPrice": 54.85, "subTotal": 54.85 }
  ],
  "extras":  { "sundries": 4.95 },
  "gross":   184.62,
  "issue":   true
}
```

### 8.2 Result JSON (output)

```json
{
  "jobId": "web-88231",
  "ga4Number": 90731,
  "stage": "ISSUED",
  "outcome": "SUCCESS",
  "verification": {
    "gate":        { "expected": 184.62, "observed": 184.62, "match": true },
    "regReadback": { "method": "clipboard", "expected": "LT19 DHD", "observed": "LT19 DHD", "match": true },
    "linesReadback": "clean",
    "issuedHeader": "no-Not-Issued && number==90731"
  },
  "timestamps": { "opened": "...", "gated": "...", "issued": "..." },
  "reason": null
}
```

### 8.3 Restart-safe state machine (screen is truth on restart, journal is a hint)

Linear saga over key **N** (the pre-reserved GA4 number). Each stage carries a Neon journal marker **and** an on-screen re-derivation predicate; on boot, branch on the **screen**, never the journal.

| Stage | Journal marker (Neon hint) | On-screen re-derivation (authority) | Idempotent re-entry |
|---|---|---|---|
| `RESERVED(N)` | pool row `available/claimed`, `ga4Number=N` | Invoices list has Doc No=N, header `Invoice: N (Not Issued)`, body empty | (re)open safely |
| `OPENED(N)` | `claimed`, `claimedByDocId=D` | header `Invoice: N (Not Issued)` frontmost | re-open draft N (double-click Open) |
| `HEADER_FILLED` | (not journaled) | reg == D.reg via **clip read-back**; Acc No ≠ "Auto Generate"; mileage present | if correct, **skip VRM Lookup** (re-run re-fires DVLA + Open-Document dialog); jump to `fillLines` (invoice.ts splits `fillInvoice`/`fillLines`) |
| `LINES_FILLED` | — | `readPortalRows(g,count)` matches D; no blank/£0.00 line | `enterLinesVerified` self-idempotent (select-all→paste + grid repair ≤4) |
| `GATED` | — | `readTotals().Total == D.gross` to the penny AND `problems==[]` | pure read; never mutate |
| `ISSUED(N)` **(irreversible)** | `filled`, `filledAt` | header **no longer** "Not Issued" AND number still == N | **do NOT re-issue**; if already issued → advance journal only |
| `RECORDED` | `filled` + `serviceHistory.ga4Number=N` | issued confirmed + journal consistent | idempotent `UPDATE … WHERE status<>'filled'` |

**Reconcile-on-boot** (before any new work, per non-terminal pool row and per `serviceHistory WEB-% … ga4Number IS NULL`): open the draft, OCR the header, and — (1) `Not Issued` + empty → resume at `HEADER_FILLED`; (2) `Not Issued` + populated → resume at first unsatisfied predicate; (3) issued + number==N → **it already issued** (crash after issue, before journal) → run post-verify, advance journal only, **never re-issue**; (4) Job-C: pre-check fresh GA4 export by **reg+total**, stamp+stop if already present. This makes double-issue structurally impossible.

---

## 9. Preflight checklist + watchdog with a real input heartbeat

**Preflight (before every job) and composite watchdog (before every irreversible action + on a timer during fills):**

1. `assertScreenUnlocked` — `CGSSessionScreenIsLocked` via Quartz (helpers.ts). Locked → FATAL.
2. Parallels frontmost (`activateParallels`).
3. **Input heartbeat** (below) — proves the mouse actually reaches the guest.
4. NumLock off — `ensureNumLockOff` (reads `[console]::NumberLock`, toggles via scancode 69, aborts if it can't).
5. Frame health — `ocrScreen` retries until **≥25 boxes** (skips the ~1–2s black/half frame after any `prlctl exec`; a rendered GA4 screen is ~100+ boxes).

All green → proceed. Any red → self-heal (`caffeinate`, re-front Parallels, toggle NumLock), re-probe; still red → MANUAL_REVIEW (mid-job) or FATAL_ENVIRONMENT (systemic). Standing mitigation: `caffeinate` + disabled auto-lock/screensaver during a run.

**Why a special probe:** `prlctl capture` reads the framebuffer even when the Mac is locked or the mouse is gated — **a valid screenshot does NOT prove the mouse reaches the guest** (07/07 gremlin: automation proceeded on dead input while screenshots looked fine). Keyboard/clipboard aren't mouse either.

**Non-destructive input heartbeat (pure cursor MOVE, zero clicks, zero data touch):**
1. Read guest cursor **P0** via `prlctl exec --current-user` GetCursorPos (cursorpos.ps1 read-only path — no SetCursorPos).
2. cliclick **move** (`m:`, not `c:`) the Mac pointer to two *distinct* absolute points over a **neutral region** (title bar / empty toolbar gutter — never a field/button), settling between.
3. Re-read guest cursor → **P1**, then **P2**. **LIVE** iff the guest cursor tracked both commanded targets within tolerance AND P1≠P2. Unchanged/stale → **channel CLOSED** (Mac locked, Parallels backgrounded, or mouse gating).

Two points (not one) prove *directional tracking*, defeating a stale cached read; a bare move over neutral chrome focuses/fires nothing in FileMaker, so it's safe mid-fill. **Mandatory immediately before `issue_invoice`** — the one spot where a dead-mouse false-success is unrecoverable.

---

## 10. Value-normalization + financial-validation rules

**Exact arithmetic (deterministic given the numbers):**
- All money math uses **`round2` (half-up)**, never `toFixed` (toFixed rounds a half-penny *down* → 7×£5.975 = £41.82 not £41.83). grid.ts already uses `round2`.
- **Totals gate to the penny** — `checkTotalsGate` (grid.ts) server-side; the gate is the proof the lines are right.
- **Per-row cross-check** `subTotal == round2(qty × unitPrice)` — confirms a qty OCR can't read (lone "1" in a narrow column) *without reading it*.
- **Independent VAT sanity** `VAT ≈ round2(net × 0.20)` (±1p) — second structural check on the panel.
- **Currency parse:** strip `£`, `,`, whitespace; parse to integer pence; reject if non-numeric residue.

**Tripwires (fire → treat as FAIL, re-derive, self-heal, retry):**
- **NumLock signature tripwire** (the 7/1/71/77/777 corruption). Keypad Home=71→"7", End=79→"1" append when NumLock ON; values become dominated by leading 7s/1s ("1"→"7771", "99.00"→"777799.40"). Predicate for a numeric field with expected `v`:
  ```js
  const numlockTrip = (obs, v) => {
    const o = obs.replace(/[£,\s]/g,''), d = o.replace(/[^\d]/g,'');
    return o !== v && (
      /^(7{2,}|1{2,}|71|17|77|11|777)/.test(d) ||
      (d.length > v.replace(/[^\d]/g,'').length + 1 && /^[71]+/.test(d))
    );
  };
  ```
  On trip → re-run `ensureNumLockOff` (aborts if it can't), clear-and-re-enter.
- **Append/length tripwire:** observed contains expected as proper prefix/suffix or is longer ("LT19 DHDLT19 DHD") → clear-failed-append → clear via the field's own red-X button (Ctrl+A can't select a Lookup combo), re-enter into a known-empty field.
- **Gate-invisible tripwire:** a £0.00 line or blank description sums correctly but is wrong → invisible to the gate → caught only by grid read-back. **Always require gate-clean AND read-back-clean.**

**OCR canonicalization (weakest tier; UNKNOWN ≠ WRONG):** glyph-fold before compare (`regKey`: O/0/D/Q→0, I/1/L→1, S/5, B/8, Z/2, G/6); band-join split tokens ("YX63"+"AKF"); a blank read is **UNKNOWN → resolve via a Tier-1 invariant**, never silently accepted.

---

## 11. Retry / MANUAL_REVIEW policy + failure taxonomy

**Governing asymmetry (drives every borderline call):** *an unfilled reserved draft is harmless and re-runnable; a wrongly issued invoice is unrecoverable.* Default at/after the gate on any uncertainty = MANUAL_REVIEW; default on any environmental doubt = FATAL_ENVIRONMENT. Never blind-retry through the irreversible door.

| Class | Concrete triggers | Action |
|---|---|---|
| **SUCCESS** | Independent post-verify: header issued + number==N; journal advanced (`filled` + `ga4Number`) | Commit; next job |
| **RETRYABLE** (bounded, idempotent on N, automatic) | eaten first Ctrl+V / blank paste (double-paste); cell didn't land (grid repair ≤4); reg empty right after VM restart (paste→`vmTypeText` fallback at attempt≥2); clipboard agent not ready (backoff 400·(n+1)ms); black/half frame (`ocrScreen` retry ≥25 boxes); tab switch swallowed (`assertTabActive` ≤3); NumLock ON (`ensureNumLockOff`); Parallels not frontmost (`activateParallels`); Open-Document dialog present (click **Ignore**, ≤4) | Retry bounded; on exhaustion → MANUAL_REVIEW |
| **MANUAL_REVIEW** (STOP, do NOT issue; journal `failed`+reason; human finishes draft N by hand) | gate mismatch survives repair; line mismatch survives 4 passes; customer ambiguous / still "Auto Generate"; MOT option outside calibrated ELI set; Open-Document won't dismiss; unknown modal; **issue post-verify ambiguous**; MOT-reminder *editor* opened | Park reserved draft (never delete); alert; continue other jobs |
| **FATAL_ENVIRONMENT** (abort run, alert, no per-job retry — retrying burns reserved numbers) | Mac **locked** (`assertScreenUnlocked` throws); **heartbeat dead** after self-heal; NumLock can't be turned off; Parallels/GA4 window missing; **pool available==0**; clipboard channel down (sync+guest read both fail); Neon unreachable | Stop, notify, leave everything parked |

**Irreversible-action guard (Issue):** (1) pre-verify all-must-hold — exactly one draft, header `Invoice: N (Not Issued)` re-OCR'd *now*, gate to the penny, grid `problems==[]`, customer verified, environment green incl. heartbeat; (2) **single-fire** (`single:true` — reliable-×2 double-fires FileMaker buttons and permanently deleted draft 90727; screenshots are stale so "still open" may already have fired; never Return on Open-Document); (3) **independent post-verify** on a fresh capture (header no longer "Not Issued" AND number==N); (4) **never auto-repeat on uncertainty** → MANUAL_REVIEW.

---

## 12. Prototype — one-safe-field read/clear/write/verify/restore loop

Realistic methods only (Mac-mouse focus → clipboard read → NumLock-safe keyboard clear → paste → clipboard read-back verify). Returns the brief's JSON.

```
function safeSetField(field, expected):
  # ---- PRE: environment must be live (mouse actually reaches guest) ----
  assertScreenUnlocked()                       # CGSSessionScreenIsLocked; throw→FATAL
  activateParallels()                          # frontmost required for cliclick
  assert inputHeartbeatLive()                  # 2-point cursor MOVE, P1≠P2 tracked; else FATAL
  ensureNumLockOff()                           # read [console]::NumberLock, toggle via sc 69, abort if stuck
  waitFrameHealthy(minBoxes=25)                # skip black frame after any prlctl exec

  # ---- FOCUS (mouse MUST be Mac-side; gated otherwise) ----
  cliclick.doubleClick(field.x, field.y)       # double-click = enter edit mode (single only selects)

  # ---- READ current value deterministically (Tier 0) ----
  sendKeys("Ctrl+A"); sendKeys("Ctrl+C")       # prlctl send-key-event (keyboard NOT gated)
  before = vmGetClipboard()                     # prlctl exec --current-user Get-Clipboard (Unicode-exact)

  if canon(before) == canon(expected):
      return result(field, expected, before, "SUCCESS", method="clip", noop=true)

  # ---- CLEAR (NumLock-immune nav via -k virtual keycodes) ----
  sendKeyK(HOME=97); sendKeyK_shift(END=103)   # dedicated nav keys; NumLock cannot remap them
  sendKeyK(DELETE=107)                          # (Lookup combo? use its red-X button instead of Ctrl+A)

  # ---- WRITE via clipboard paste (exact, avoids per-glyph keying) ----
  pbcopy(expected)                              # → Parallels shared clipboard
  sendKeys("Ctrl+V")

  # ---- VERIFY (read-back, deterministic) ----
  sendKeys("Ctrl+A"); sendKeys("Ctrl+C")
  after = vmGetClipboard()

  if numlockTrip(after, expected):             # 7/1/71/77/777 signature
      ensureNumLockOff(); return retry(field, expected)     # bounded RETRYABLE
  if appendTrip(after, expected):              # "LT19 DHDLT19 DHD"
      clearViaRedX(field); return retry(field, expected)
  if canon(after) != canon(expected):
      return result(field, expected, after, "MANUAL_REVIEW", method="clip")

  return result(field, expected, after, "SUCCESS", method="clip")

# JSON out:
# { "field":"registration","expected":"LT19 DHD","observed":"LT19 DHD",
#   "match":true,"outcome":"SUCCESS","method":"clipboard","numlockTrip":false }
```

Notes: keyboard/clipboard/screenshot never need the mouse, but **focus does** — hence the Mac-mouse double-click is unavoidable and gates the whole loop behind Mac-unlocked + heartbeat. Nav clear uses `-k` virtual keycodes as belt-and-suspenders atop `ensureNumLockOff`.

---

## 13. Phased migration plan (tailored to reality)

- **Phase 1 — Stabilize input (MOSTLY DONE, PROVEN).** NumLock guard shipped + verified end-to-end; frame-health ≥25-box retry shipped; screen-unlock assertion in place; cliclick mouse + `prlctl send-key-event` keyboard working. **Remaining Phase-1 polish:** switch nav cluster from `-s` bare scancodes to `-k` virtual keycodes; batch clear-and-fill chords via `-j` JSON to cut process-spawn overhead.
- **Phase 2 — Deterministic verification.** Wire clipboard read-back (`vmGetClipboard` via `prlctl exec --current-user Get-Clipboard`, vm.ts) into the verification tier for reg (before the slow VRM lookup) and the final pre-issue confirmation. Biggest single reliability win; no new infrastructure.
- **Phase 3 — Input heartbeat + composite watchdog.** Add the 2-point cursor-MOVE heartbeat (cursorpos.ps1 read path + cliclick move); make it mandatory immediately before `issue_invoice` and on a timer during fills.
- **Phase 4 — Idempotent state machine + reconcile-on-boot.** Implement §8 stages, screen-re-derivation predicates, and the irreversible-action guard. Neon journal as hint; screen as truth.
- **Phase 5 — Windows session-1 co-processor (optional, additive).** Clone `GA4_PDF_Watcher` via `schtasks /it` to launch `ga4-agent.ps1`; use its TCP :8765 for VK keyboard + GDI screenshot + clipboard read-back. **Mouse stays on the Mac.**
- **Phase 6 — Native-dialog UIA spike.** Read-only probe of a live `#32770` / Codejock menu for `InvokePattern`/`IAccessible`; if present, drive confirm/cancel buttons *without* the mouse gate. Guard heavily (destructive-dialog memory). Ship only if the read-only probe is unambiguous.
- **Phase 7 — Unattended issue/stamp.** Only after Phases 2–4 are proven over a batch of real Issues with the guard tripping correctly on injected faults (see §15).

---

## 14. Known limitations & unresolved risks

- **Mouse gate is inherent.** Guest synthetic mouse is dead unless Parallels is frontmost; the only escape (RDP's independent input queue) is **unavailable — Windows HOME edition = no RDP host**. The mouse must stay Mac-side and requires **Mac-unlocked + Parallels-frontmost**. This caps the system at attended-or-kiosk operation (a dedicated always-unlocked Mac with caffeinate + auto-lock disabled).
- **Clipboard read-back still needs a mouse focus.** It's a superior *verifier*, not an input bypass — every read requires selecting the field via the same gated mouse+key path.
- **`-s` E0 scancode delivery UNVERIFIED.** `-s 57415 (0xE047)` parses but delivery isn't confirmed; do not rely on `-s` for nav — use `-k` virtual keycodes.
- **`prl_fs` shared folder is eventually-consistent**, not atomic — never rely on atomic rename/locks across the boundary; prefer TCP for live control.
- **Native-dialog UIA is UNTESTED here.** The prize (non-mouse invoke) is real but unproven; FileMaker-*drawn* dialogs stay canvas. Treat as a spike, not a plan.
- **Screenshots lie about input.** A valid frame never proves the mouse reached the guest; the heartbeat is the only proof and adds latency.
- **Human co-use of the VM.** Single-flight + "GA4 frontmost + expected header" preconditions are mandatory; a human grabbing the mouse mid-fill must pause automation.
- **Frame blanks for ~1–2s after every `prlctl exec`** — every read that follows an exec must pass frame-health first.
- **Pool exhaustion is a FATAL, not a retry** — retrying issue-path work when `available==0` burns numbers; must halt.

---

## 15. Additional experiments worth running before trusting unattended issue/stamp

1. **Native-dialog UIA read-only probe (highest value).** With a real confirm/Open-Document dialog up, `EnumWindows` for `#32770` + a BUTTON child; point UIA-v2/Acc-v2 at the dialog *and* at the `XTPToolBar` HWNDs (not the document subtree). Determine per-dialog whether `InvokePattern`/`IAccessible.DoDefaultAction` exists. Read-only only.
2. **Delete/Issue confirm classification.** Is the Issue/delete confirmation an OS `MessageBox`/`#32770` (real controls) or FileMaker-drawn (canvas)? One-shot EnumWindows probe when the confirm is up. Determines whether the guard can use a non-mouse invoke or must OCR+cliclick.
3. **`-k` nav delivery under NumLock-ON, adversarial.** Force NumLock ON, then clear-and-fill via `-k 97/103/107` only (skip `ensureNumLockOff`) to *prove* `-k` is genuinely NumLock-immune in delivery, not just in theory.
4. **Heartbeat false-negative/positive calibration.** With Mac deliberately locked and with Parallels backgrounded, confirm the 2-point heartbeat reports CLOSED; with everything green, confirm LIVE. Establish tolerance thresholds.
5. **Injected-fault guard drill.** Deliberately corrupt a line (£0.00 line, swapped description, appended reg) and confirm the gate∧read-back guard catches each and routes to MANUAL_REVIEW *without* issuing.
6. **Crash-between-issue-and-journal recovery.** Kill the orchestrator immediately after an Issue click; confirm reconcile-on-boot reads the issued header, advances the journal, and does NOT re-issue.
7. **`-j` JSON batch atomicity.** Verify a batched clear-and-fill chord over stdin preserves key order + inter-key delays vs. N separate spawns, with no dropped keys.

---

**Bottom line for the owner:** stop hunting for a FileMaker field API or a UIA/pywinauto/FlaUI value path — it does not exist on this runtime and never will. The realistic, high-reliability system is the hybrid you already have 80% of: Mac-side mouse+OCR+NumLock-guarded keyboard as the controller, plus a thin non-mouse Windows co-processor for deterministic clipboard read-back verification and (optionally) native-dialog UIA. The corruption that cost you days is solved (NumLock scancode aliasing → `ensureNumLockOff` + `-k` virtual keycodes). The remaining work is verification determinism, an idempotent state machine keyed on the pre-reserved number N, a guarded single-fire on Issue, and a real input heartbeat so a locked Mac can never let the automation issue an invoice into a dead mouse.