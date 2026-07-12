# GA4 Automation — Opportunities, Hardening & Roadmap

**Audience:** owner/senior engineer who already holds the architecture report
([filemaker-automation-architecture.md](./filemaker-automation-architecture.md)) and the NumLock
root-cause fix. This report is strictly about what was *missed* — the remaining, actionable path to a
deterministic, production-grade system.

**Legend:** `[PROVEN]` = verified live on this stack this session · `[RESEARCH]` = sourced from
docs/repos, needs local confirmation · `[SPIKE]` = one focused experiment decides it · `[SAFE-NOW]` =
shippable without new risk.

**One-line reminder on settled negatives (not re-litigated):** FileMaker 14 runtime paints fields into
an `AfxWnd120u` canvas — no per-field HWND/ValuePattern/TextPattern, no COM/ODBC/Data API.
UIA/pywinauto/FlaUI cannot read or set a *field*. Everything below routes around that, not through it.

---

## Live verification log (this session — reproducible)

These are the two headline claims, verified directly on this machine (not sub-agent report), with the
exact commands so they can be reproduced:

**1. The Parallels SDK exports a device-level mouse injector — the ungated sibling of the keyboard path.**

```
$ nm -gU "/Applications/Parallels Desktop.app/Contents/Frameworks/\
ParallelsVirtualizationSDK.framework/Versions/11/libprl_sdk.11.dylib" | grep -iE 'PrlDevMouse|SendKeyEvent|LoginLocal|ConnectToVm'
_PrlDevMouse_Event
_PrlDevMouse_SetPos      _PrlDevMouse_SetPosEx
_PrlDevMouse_Move        _PrlDevMouse_MoveEx
_PrlDevKeyboard_SendKeyEventEx     ← what `prlctl send-key-event` wraps (proven ungated, works Mac-locked)
_PrlDevDisplay_ConnectToVm         _PrlSrv_LoginLocal
$ strings …/libprl_sdk.11.dylib | grep -iE 'ABS_MOUSE|REL_MOUSE'
PRL_ERR_VM_SEND_ABS_MOUSE_NOT_CREATED / _NOT_RUNNING / _PAUSED   (+ REL_MOUSE variants)
$ ps -axo user,comm | grep prl_disp_service   → root
$ prlctl   → verbs include send-key-event but NO send-mouse-event
```

So the absolute-mouse inject is **compiled into the on-box build (26.4.0)** with created/running/paused
error states, backed by a **root** daemon; the CLI simply never surfaced a `send-mouse-event` verb.
This is the strongest possible pre-spike evidence that the mouse gate has a host-side escape. See §5.

**2. Transactional clipboard — proof-of-fresh-copy works, and a naive read is genuinely unsafe.**

Live on draft 90750, reading `GetClipboardSequenceNumber` / `GetClipboardOwner` via
`prlctl exec --current-user`:

| Scenario | seq# | owner | `Get-Clipboard` value |
|---|---|---|---|
| Copy that **silently failed** (double-click missed the cell) | 429 → **429** (no change) | `CPInterceptor` | **stale Mac text** bled in via Parallels shared clipboard ❌ |
| Copy that **succeeded** | 429 → **437** (jumped) | `Garage Assistant GA4` / class `FMPRO14.0RUNTIME` | actual selection ✓ |

Confirms: (a) **seq#Δ is a deterministic proof-of-copy** — no increment ⇒ the copy never happened and
the value must not be trusted; (b) Parallels' `CPInterceptor` **bleeds stale Mac clipboard into the
guest**, so a bare `Get-Clipboard` can read unrelated content that passes/fails at random; (c) owner
*can* be the GA4 window on a fresh copy (usable as a corroborating signal, not primary — timing-dependent
vs `CPInterceptor`); (d) **`Ctrl+A` does NOT select-all a FileMaker portal cell** (it copied only the
double-clicked word `Gas`), so read-back must use `Home`→`Shift+End`. See §2(a)/§7.

---

## 1. Critique of the existing architecture — where it is still fragile

The current hybrid (Mac: prlctl capture + Apple Vision OCR + cliclick + prlctl send-key-event +
shared-clipboard paste; Windows session-1: one-shot `prlctl exec` reads) works, but has these residual
non-determinisms:

1. **The per-exec frame-blackout tax `[PROVEN]`.** Every `prlctl exec --current-user` costs **~0.86s
   mean / 1.5s tail** *and* blanks the capture framebuffer for ~1–2s, forcing an `ocrScreen` retry. A
   single clipboard read via exec therefore costs ~1.2–2.5s wall and destroys any in-flight screenshot;
   a copy-verify-readback field write can burn **3–7s of pure channel overhead**. Reads and screenshots
   are *mutually destructive* today.

2. **Clipboard read without proof-of-copy.** A bare `Get-Clipboard` after Ctrl+C cannot distinguish
   "GA4 copied the cell" from "Ctrl+C was a no-op on an unselected cell and I'm reading a stale Mac value
   bled in via `CPInterceptor`." This is the single worst failure class: **garbage that reads back as
   success.** (Verified live above.)

3. **OCR-polled modals.** Destructive dialogs are detected by screenshot polling, which renders **stale**
   — a "still open" frame may already have fired. This already permanently deleted draft 90727. Polling
   also adds latency and can miss a modal that appears and is acted on between frames.

4. **Mouse tied to Mac-unlock + Parallels-frontmost `[PROVEN gate]`.** The entire click surface dies when
   the Mac is locked or Parallels is backgrounded. No unattended/headless clicking today; a human alt-tab
   mid-job silently drops clicks.

5. **Verification that trusts a *visible* value.** OCR of a field "looking right" is not proof the value
   is committed — Vision confidence is coarse (clusters at 0.5/1.0) and high confidence ≠ correct. A
   single-frame read can pass on a mid-repaint or wrong-record frame.

6. **Single-frame OCR + a weak frame-health gate.** "≥25 boxes = healthy" only proves OCR found
   *something*; it passes mid-repaint frames and wrong-screen frames. No settle-detection, no multi-frame
   consensus, no wrong-layout guard.

7. **Scancode-based keyboard is NumLock/layout-exposed.** Even with `ensureNumLockOff()`, the host
   `prlctl send-key-event` path is scancode-only; the keypad Home=71/End=79 aliasing class is *guarded*,
   not *structurally eliminated*.

8. **No durable transaction spine.** Reserve-before-risk stamps `serviceHistory.ga4Number` after issue,
   but there's no crash-consistent journal that lets a restart reconcile "did I already issue N?" from
   the screen. A crash between Issue and stamp risks a duplicate issue.

9. **`prlctl exec` is the *only* session-1 channel** despite `ga4-agent.ps1` (TcpListener :8765) already
   existing — so every read pays the exec tax and blanks the frame, when a persistent loopback agent
   would cost ~1–5ms and touch nothing in the display path.

---

## 2. Improvements NOT previously identified (lead with the biggest)

### (a) TRANSACTIONAL clipboard — proof-of-fresh-copy `[PROVEN primitives]` `[SAFE-NOW]`

**What:** never trust a clipboard read again without independent witnesses: **seq#Δ** + **owner==GA4** +
**nonce**.

- `GetClipboardSequenceNumber()` increments on *every* content change `[PROVEN: 429→437 on real copy,
  429→429 on failed copy]`. Read before Ctrl+C, bounded-wait for after > before.
- `GetClipboardOwner()` → `GetWindowThreadProcessId()` == GA4 PID (class `FMPRO14.0RUNTIME`)
  `[PROVEN: owner was GA4 on a fresh copy]` — corroborates *GA4* set it, not a stale bleed. Not primary
  (Parallels `CPInterceptor` may re-own after Mac-sync); use seq#Δ as the decisive signal.
- **Nonce:** pre-seed clipboard with `GA4NONCE-<guid>`; if seq# never moves OR the read-back equals the
  nonce, the copy never fired (cell wasn't selected).

**Why more deterministic:** converts the worst failure mode (stale garbage masquerading as success) into
a hard, catchable `COPY_FAILED`. Read-back was already `[PROVEN]` Unicode-byte-exact ("Air Con Re-Gas -
R134a (450g)"), so a value mismatch now genuinely means the write didn't land. Full protocol coded in §7.

### (b) In-guest SendInput UNICODE keying — retires scancode aliasing entirely `[RESEARCH]` `[SPIKE-small]`

**What:** type field text with `SendInput` using `KEYEVENTF_UNICODE` (`wVk=0, wScan=codepoint`) from the
session-1 agent, instead of scancodes.

**Why more deterministic:** unicode injection is **layout-immune AND NumLock-immune** — it injects the
character directly and never touches the keypad scancode path, structurally eliminating the entire
7771/scancode-aliasing corruption class (not merely guarding it). Microsoft itself steers here:
journaling is deprecated, "we highly recommend calling the SendInput TextInput API instead." Keep
`ensureNumLockOff()` as belt-and-suspenders. **Caveat:** chords (Ctrl+C/V/A) must still use **VK codes**
(unicode bypasses the Ctrl keyboard-state read); nav keys use **extended scancodes** (`E0 47` Home /
`E0 4F` End with `KEYEVENTF_EXTENDEDKEY|SCANCODE`) which are NumLock-unambiguous by construction.
Keyboard is not gated, so this is pure determinism, not a gate escape.

### (c) Event-driven dialog detection + non-mouse UIA Invoke `[PROVEN foothold]` `[RESEARCH actuation]`

**What:** replace OCR-polling of modals with `SetWinEventHook` (`EVENT_OBJECT_SHOW` +
`EVENT_SYSTEM_FOREGROUND`, filtered to GA4 PID) as a push trip-wire, then classify each new top-level
window by `GetClassName`:
- `#32770` → real Windows dialog with real child `Button` HWNDs → press via UIA `InvokePattern.Invoke()`
  — **zero mouse, bypasses the gate entirely** (same ungated status as keyboard/clipboard).
- `FMPRO14.0RUNTIME` / zero child Button elements → FileMaker canvas "card window" → stays on OCR +
  `click_text`/keyboard-accelerator path, now *explicitly classified* instead of guessed.

`[PROVEN]` this session: `GetMenu(mainHWND)` returned a valid HMENU with **8 top-level items** — the
runtime *does* expose a native Win32 menu bar (class `#32768`), a second semantic, mouse-free actuator
alongside `#32770` dialog buttons.

**Why more deterministic:** ms-latency push instead of stale polling; `Invoke()` is a single
deterministic activation (strictly safer than the double-firing `click` that deleted 90727). The
per-dialog "which button" policy (never Return on Open-Document → Delete+View) is encoded by matching
`.Name`, unchanged.

### (d) Persistent session-1 agent — kills the exec tax + frame-blackout `[PROVEN tax]` `[agent exists]`

**What:** route all session-1 ops (Get-Clipboard, seq#, owner, NumLock, window enum, cursor pos,
Get-Date) over the already-built `ga4-agent.ps1` TcpListener :8765 line-JSON channel instead of
`prlctl exec`.

**Why more deterministic:** ~1–5ms loopback vs ~860ms exec (**2 orders of magnitude**), and critically
**it never blanks the framebuffer** — screenshots and reads become *independent* instead of mutually
destructive, removing an entire race class. It can also push clipboard changes via
`AddClipboardFormatListener`/`WM_CLIPBOARDUPDATE` (event, not poll) with the owner-HWND attached. Detail
in §12.

### (e) Perceptual-hash frame stability + evidence `[RESEARCH]` `[SAFE-NOW]`

**What:** dHash/pHash the raw capture PNG (reuse the existing Swift Vision binary via vImage/CoreImage —
no new dep).
- **Settle gate:** two consecutive frames Hamming ≤2 ⇒ frame settled, safe to act. Detects black/half
  frames the box-count passes.
- **Change detection:** hash before/after an action; distance ~0 after an expected state change ⇒
  no-op/dead click (gate closed) — a deterministic failure signal with no OCR.
- **Evidence:** store `{beforeHash, afterHash, PNGs, clipSeq#, ts}` per irreversible action.

---

## 3. GitHub projects worth investigating (curated, new)

- **oblitum/Interception** — kernel-mode input filter driver; injects at the guest driver layer *below*
  the OS input stack, i.e. potentially the *inside-guest* escape from the Parallels gate. Signed driver
  (no test-signing needed in principle). `[RESEARCH]` **Caveats:** admin + reboot required (blocked on
  Win11 **Home** without admin); documented Win11 partial-install flakiness; kernel driver on the boot
  path = high blast radius. **Only test on a throwaway VM clone.** Rank *below* the SDK mouse path (§5).
- **JohannesBuchner/imagehash** (PyPI `ImageHash`) and **benhoyt/dhash** — aHash/pHash/dHash for the
  §2(e) frame-settle + evidence layer. Or OpenCV `img_hash` module if avoiding the Python stack.
- **FlaUI** (`FlaUI.Core`/`FlaUI.UIA3`) — *dialog/window-level only* (WindowPattern, WindowOpenedEvent,
  InvokePattern). Field patterns are dead here; useful strictly as a dialog actuator from PowerShell.
  Note: `Invoke()` throws on off-screen/disabled elements — guard with `IsEnabled`/`IsOffscreen`, fall
  back to Enter/accelerator.
- **InterceptionSharp / node-interception** — bindings if Interception is ever spiked.
- **Rule out:** **ViGEmBus / vJoy / pyvjoystick** — virtual *gamepad/joystick* HID only; cannot create a
  virtual mouse/absolute pointer, so they cannot drive the GA4 cursor. Don't spend time here despite the
  "virtual HID" framing.
- **abdus.dev clipboard-monitor** — reference impl for `AddClipboardFormatListener` in Python.

---

## 4. Microsoft APIs worth investigating

- **`GetClipboardSequenceNumber`** `[PROVEN]` — the seq#Δ proof primitive.
- **`GetClipboardOwner` + `GetWindowThreadProcessId`** `[PROVEN callable]` — "who copied" proof.
- **`IsClipboardFormatAvailable` / `RegisterClipboardFormatW`** — format hygiene (require
  CF_UNICODETEXT=13; detect stray CF_HTML/CF_RTF on grid copies).
- **`AddClipboardFormatListener` + `WM_CLIPBOARDUPDATE` (0x031D)** — event-driven clipboard proof (push,
  not poll); MS-recommended over the legacy viewer chain.
- **`SetWinEventHook`** (`EVENT_OBJECT_SHOW` 0x8002 / `EVENT_SYSTEM_FOREGROUND` 0x0003 /
  `EVENT_SYSTEM_DIALOGSTART` 0x0010) — push modal detection. Requires a message pump on the hook thread;
  pin the managed callback with `GCHandle`.
- **UIA `WindowPattern.WindowOpenedEvent`** — richer actuator channel (hands you the new window's element
  directly).
- **`SendInput`** with `KEYEVENTF_UNICODE` (text) / VK (chords) / `KEYEVENTF_EXTENDEDKEY|SCANCODE` (nav)
  — the deterministic keyboard core (§8).
- **`GetAsyncKeyState` / `GetKeyState` (VK_NUMLOCK=0x90)** — pre-flight assertions: confirm a modifier is
  actually held mid-chord; independent second read of NumLock vs `[console]::NumberLock`.
- **`GetMenu`/`GetMenuItemCount`** `[PROVEN: 8 items]` + menu class `#32768` — native menu-bar actuator
  (mouse-free command path).
- **UIPI hazard to design around:** `SendInput` silently no-ops (no return/GetLastError signal) if GA4
  runs at higher integrity than the agent. Run agent at same integrity as GA4; rely on the clipboard ACK
  to *detect* silent drops.

---

## 5. Parallels internals worth investigating — the headless-mouse prize

**★ The lead that could obsolete the mouse gate `[PROVEN symbols present — see verification log]`
`[SPIKE decides]`:**

The Parallels SDK dylib backing `prlctl` — **present on this box** at
`…/ParallelsVirtualizationSDK.framework/Versions/11/libprl_sdk.11.dylib` — **exports a full mouse
device-injection API**, the exact sibling of the keyboard injector already used ungated:

```
_PrlDevMouse_SetPos   _PrlDevMouse_SetPosEx   _PrlDevMouse_Move/_MoveEx   _PrlDevMouse_Event
_PrlDevKeyboard_SendKeyEventEx   ← what prlctl send-key-event wraps (proven ungated)
_PrlDevDisplay_ConnectToVm   _PrlSrv_LoginLocal
```

The dylib also carries the matching error codes (`PRL_ERR_VM_SEND_ABS_MOUSE_NOT_CREATED/NOT_RUNNING/
PAUSED`, plus `_REL_MOUSE_*`) — the capability is wired; the CLI just never surfaced a `send-mouse-event`
verb. `prl_disp_service` runs **as root** `[PROVEN via ps]`.

**Why this defeats the gate (hypothesis):** the gate acts on *guest-OS-level* synthetic input (in-guest
SendInput/SetCursorPos overwritten every frame by the absolute-tablet driver when Parallels isn't
frontmost). `PrlDevMouse_SetPos` injects at the **emulated device in the device model** via the same
host→root-daemon channel as `send-key-event` — which is *already proven ungated* (works
Mac-locked/headless). It delivers **absolute** clicks in the guest display grid (the 1456×1268 space),
exactly what the OCR-box workflow wants, and naturally supports the double-click-to-edit need (SetPos
button-down then button-up).

**Confirmed vs lead:**
- Confirmed `[PROVEN]`: symbols exported on-box; error codes compiled into the dylib; root daemon;
  keyboard sibling ungated.
- Lead (the spike gate): does `ConnectToVm`/device-inject **return success on Parallels Desktop for
  Mac** (Remote Desktop Access was historically a Server feature)? Symbol presence is strong evidence,
  but connect-returns-OK is the decision point.

**Two ways to call, no VM change:** (1) `ctypes`/tiny Swift-C binary directly against the on-disk dylib
(zero install — `prlsdkapi` Python bindings are **NOT** on disk); (2)
`brew install --cask parallels-virtualization-sdk` for official `prlsdkapi` + headers + exact
`PRL_MOUSE_*` button constants (host dev-tool install, not a VM/GA4 change).

**Mouse-integration-disable hypothesis — DROP it.** There is **no prlctl flag** to force a
captured/relative PS2 mouse or disable mouse integration. Flat flags exist (`--smart-mouse-optimize`,
`--sticky-mouse`, `--modality-capture-mouse-clicks`, `--keyboard-optimize`) but none is a headless-input
toggle. Moot anyway if the SDK path lands. `[PROVEN: prlctl set Win11Manual mouse → "Unrecognized
option"]`. If the SDK spike interacts with game/smart-mouse capture, `--smart-mouse-optimize off` is the
first variable to test.

**ToolGate / prl_fs — not needed.** The `PrlDevMouse_*` path is host→hypervisor; it needs no in-guest
agent or ToolGate RPC to ask for a click. Simpler than any prl_fs scheme; retires the dead
`ga4-agent.ps1` in-guest-mouse click.

**The spike (read-mostly, one safe risk, no GA4 data touched):**
1. dlopen/ctypes → `PrlApi_Init` → `PrlSrv_LoginLocal` → find `Win11Manual` → `ConnectToVm().wait()`.
   **Checkpoint: does connect return OK on Desktop-for-Mac?**
2. Cursor-move only, no button, Mac **locked** → confirm guest cursor moved via capture. Movement alters
   nothing.
3. One click on an **inert** target (empty desktop / scratch Notepad — NOT GA4). If it registers
   Mac-locked, the gate is broken.

`prlsdkapi` fallback introspection for button-flag constants:
`print prlsdkapi.prlsdk.consts.__dict__` once connected.

---

## 6. Production watchdog design

Host-side supervisor loop, ~2–5s cadence, gating every risky action. Every probe read-only.
`[PROVEN latencies]`.

| Failure mode | Read-only probe | Trigger | Recovery |
|---|---|---|---|
| VM stopped/paused | `prlctl status` (0.02–0.10s) | status ≠ `running` | halt; never inject into a paused VM |
| Guest OS frozen | two agent `Get-Date` reads Δt apart; or exec timeout | guest clock delta < 0.5× host, or exec >5s (baseline 0.86s) | pause job; exec-timeout is the strongest freeze signal |
| UI frozen while "working" | dHash the edited sub-region | hash unchanged after a keystroke/paste was sent | flag stall; re-capture; if persists, wedged |
| Black/half frame | OCR box count | boxes < 25 | retry capture; **attribute** — if post-exec, it's the framebuffer blank, not a freeze |
| Dialog deadlock | WinEvent push + agent `GetWindowText`/`GetClassName` | modal HWND the state machine didn't open | **STOP**, never send Return (Delete+View destroys the pool draft); alert human |
| Focus loss | agent `GetForegroundWindow` + PID vs GA4 | foreground ≠ GA4 | `SetForegroundWindow` (proven in agent), re-verify before any click |
| Mouse-reaches-guest heartbeat | host cliclick move A→B, read cursor via agent `[Cursor]::Position` | reported ≠ commanded | gate closed → do not attempt click stages; fall to keyboard-only or park |
| Clipboard channel | seq# before/after a known pbcopy | no increment | shared-clipboard sync stalled; re-sync, don't trust paste |
| Keyboard channel | benign key into scratch field, read back | no echo | keyboard path dead |

**Structural note `[PROVEN]`:** `prlctl statistics` **does not exist** in 26.4.0 — no guest CPU/mem
telemetry via prlctl, so guest-health must come from the in-guest agent. Guest **Uptime 406 days**
`[PROVEN]` — the VM never reboots: the watchdog must recover *in place* (no reboot ever clears a wedged
modal); the persistent agent must survive months (bounded buffers, no unbounded in-guest log growth).
Add a **host-side kill-switch flag file** checked each cycle; halt at the next stage boundary, never
mid-Issue.

---

## 7. Clipboard verification — full transactional protocol (coded)

P/Invoke surface (one `Add-Type` block, load via base64 `-EncodedCommand` — `[PROVEN]` inline
`Add-Type -MemberDefinition` fails quote-escaping through prlctl; here-string `Add-Type $sig` base64
works; set `$ProgressPreference='SilentlyContinue'` to drop the CLIXML banner):

```csharp
public static class Clip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint fmt);
  [DllImport("user32.dll")] public static extern bool AddClipboardFormatListener(IntPtr h);
  [DllImport("user32.dll")] public static extern uint RegisterClipboardFormatW(string s);
  // WM_CLIPBOARDUPDATE=0x031D ; CF_UNICODETEXT=13
}
```

**NONCE read protocol (catches "nothing selected"):**
```
nonce = "GA4NONCE-" + guid
SetClipboardText(nonce); seed = GetClipboardSequenceNumber()
SendCtrlC()                                    // VK chord, §8
waitForSeqChange(seed, timeout=250ms)          // bounded poll, 5–10 reads @10ms
val = GetClipboardText(CF_UNICODETEXT)
if (seq unchanged) OR (val == nonce): return COPY_FAILED   // copy never fired
```

**Write verifier (per field):**
```
bool verifyFieldEquals(expected, ga4Pid, timeoutMs=250):
    seq0 = Clip.GetClipboardSequenceNumber()
    SendSelectAll()                             // field-scoped: Home→Shift+End (Ctrl+A does NOT select a FM portal cell — proven), or VK Ctrl+A where valid
    SendCtrlC()
    if not waitSeqChange(seq0): return FAIL_NO_COPY
    Clip.GetWindowThreadProcessId(Clip.GetClipboardOwner(), out pid)
    if pid != ga4Pid: return FAIL_WRONG_OWNER    // stale/other-app value
    if not Clip.IsClipboardFormatAvailable(13): return FAIL_FORMAT
    got = GetClipboardText(CF_UNICODETEXT)
    if Normalize(got) != Normalize(expected): return FAIL_MISMATCH(got)
    return OK   // optional SHA256 for whitespace-sensitive fields
```

`Normalize` = trim + NFC + collapse GA4 reg-spacing per the split-matching memo. **Format hygiene:**
reject if `RegisterClipboardFormatW("HTML Format")`/`("Rich Text Format")` is present when a plain field
value is expected (grid copies carry CF_HTML/CF_RTF). **Event mode:** for the persistent agent,
`AddClipboardFormatListener` pushes `WM_CLIPBOARDUPDATE` with owner attached — proof without polling.
(Caveat: seq# doesn't increment for *delayed-render* clipboards; FileMaker Ctrl+C does immediate
`SetClipboardData`, so this doesn't bite — but read back the data, don't trust seq# alone.) `[PROVEN]`
byte-exact readback makes `FAIL_MISMATCH` trustworthy.

---

## 8. Keyboard improvements

- **Text → `KEYEVENTF_UNICODE`** (`wVk=0, wScan=codepoint`, down then `|KEYEVENTF_KEYUP`): layout- and
  NumLock-immune; **structurally retires the scancode-aliasing corruption class.** Default for every
  field value.
- **Chords (Ctrl+C/V/A) → VK codes** as a single atomic 4-element `INPUT[]` (`VK_CONTROL=0x11` down, key
  down, up, up). Unicode bypasses the Ctrl state read, so chords must be VK.
- **Nav (Home/End/Tab/Enter/arrows) → extended scancodes** `E0 47`/`E0 4F` with
  `KEYEVENTF_EXTENDEDKEY|SCANCODE` — NumLock-unambiguous by construction; the real structural fix beneath
  `ensureNumLockOff()` (keep the latter as belt-and-suspenders).
- **Keyboard ACK:** keyboard is fire-and-forget — borrow the clipboard as the ACK channel: type → Ctrl+A
  → Ctrl+C → seqΔ + value-match (§7). Full round-trip proof characters reached the field, which OCR
  alone can't give.
- **Idempotent retry:** wrap each op `{opId, field, expected}`; on `FAIL_*`, recover field-scoped:
  select-all → Delete → re-type → re-verify, ≤N tries. Select-all+delete fully replaces contents, so
  retries are idempotent (old corruption came from a *failed* clear that verify() now catches first).
  **Never retry blind — only on a verify FAIL.**
- **Batching:** in-guest agent batches a whole field's keystrokes into one `SendInput INPUT[]` (atomic,
  buffers stray physical input). Host `prlctl send-key-event -j` batches scancodes (NumLock-exposed)
  fallback only.
- **Preference:** default to in-guest `SendInput` for all text/chords/nav (kills the corruption class);
  fall back to `prlctl send-key-event` (NumLock-guarded) only for cold-start or agent-down. Both ungated.
- **Pre-flight:** `GetAsyncKeyState` confirms a modifier is actually held mid-chord (catches a dropped
  Ctrl-down).

---

## 9. Mouse improvements (honest set)

**What can improve *given* the gate, today `[SAFE-NOW]`:**
- **Keyboard-first navigation** — reach every Tab/Shift-Tab/arrow/Enter-accessible field without the
  mouse (all ungated, now deterministic). Shrinks the surface that needs the gated mouse to almost
  nothing.
- **Native menu-bar path** `[PROVEN: 8 HMENU items]` — drive menu commands mouse-free via UIA
  Invoke/posted command.
- **`#32770` dialog buttons via UIA `InvokePattern.Invoke()`** — mouse-free, single deterministic
  activation (safer than the double-firing `click`).
- **OCR-grounded absolute cliclick** — keep as current-known-good for the residual canvas clicks
  (Mac-unlocked + Parallels-frontmost), gated by the mouse heartbeat (§6) and single-flight lock (§13).

**Spikes that could retire the gate:**
1. **`PrlDevMouse_SetPos`** (§5) — highest value, ~1 spike. If ungated like `send-key-event`, delivers
   headless absolute clicks and obsoletes cliclick/RDP/Interception.
2. **Interception on a VM clone** (§3) — guest-driver-level injection; second-choice, admin+reboot+blast
   radius, clone-only.
3. **Confirmed dead — do not re-attempt:** in-guest SendInput/mouse_event/SetCursorPos mouse; AutoHotkey
   (all Send modes feed the gated guest stream; SendPlay/journaling unsupported on Win11); ViGEm/vJoy
   (gamepad-only). RDP host unavailable on Win11 Home.

---

## 10. Failure-recovery improvements — "screen is truth"

**Idempotency key = the pre-reserved GA4 number `N`.** Neon journal is a *hint*; the **GA4 screen is
source of truth** on restart.

Stage model, each re-derivable from the screen: `RESERVED → DRAFT_OPEN → FIELDS_FILLED → ISSUED →
JOURNALED`.

- **Duplicate-issue prevention (crash between ISSUED and JOURNALED):** on restart, OCR the issued invoice
  number/flag before re-issuing.
  - Screen shows `N` issued but Neon unstamped → **do not re-issue**; replay only stage 5 (stamp Neon).
  - Draft open, unissued → resume stage 3/4.
  - A *different* number issued for this reg → human review (pool/draft desync).
- **Rollback reality:** stages 1–3 reversible (delete draft, re-null fields); **stage 4 Issue is NOT**
  (GA4 has no un-issue). Therefore pre-commit verification *is* the safety story: penny-gate + field
  read-backs + no-unexpected-modal must all pass in the **same frame** immediately before the Issue
  keystroke, with no intervening exec that could blank/refresh state.
- **Partial-invoice resume:** stage 3 journaled per-field `{field, value, verified_seq#}` → resume at the
  first unverified field, not restart (which risks the append-duplication class).
- **Compensating log** for the one reversible destructive op (deleting a scratch draft):
  `{action:delete_draft, target_docno, reason, screen_hash_before}`, with the one-activation/`single:true`/
  screenshot-may-be-stale discipline (a single click deleted 90727).

---

## 11. Logging improvements — structured JSON + evidence bundles + replay

One append-only JSONL stream, one object per action, keyed `{job_id, N, stage, seq}`:

```json
{ "ts":"...", "job_id":"...", "N":90734, "stage":"FIELDS_FILLED",
  "action":"paste_field", "field":"description",
  "intended":"Air Con Re-Gas - R134a (450g)",
  "evidence":{ "clip_seq_before":424,"clip_seq_after":425,
    "clip_owner_hwnd":"0x00A31F","readback":"Air Con Re-Gas - R134a (450g)",
    "readback_match":true,"frame_hash_before":"9f3c…","frame_hash_after":"7ab1…",
    "numlock":false,"foreground_hwnd_is_ga4":true },
  "timings":{"send_key_ms":210,"capture_ms":180,"ocr_ms":320,"agent_read_ms":3},
  "result":"ok" }
```

- **Attached evidence = each step independently auditable:** seq#Δ proves the copy, owner-HWND proves GA4
  did it, readback proves the value, before/after hash proves the screen changed. A reviewer replays the
  decision without the VM.
- **Screenshots content-addressed** (`frames/<sha256>.png`, hash referenced in the log) — dedupes
  near-identical frames; the months-long/406-day-uptime log stays small.
- **Deterministic replay:** every input + observed gate recorded → a failure is reproducible from the log
  alone in a dry-run harness.
- **Latency histograms (p50/p95/p99)** come from the same `timings` stream — a p99 exec creeping 1.5→5s
  is an early freeze warning.

---

## 12. Performance improvements — the persistent agent is the headline

**Quantified tax `[PROVEN]`:** `prlctl exec` = **~0.86s mean / 1.5s tail** + ~1–2s framebuffer blank +
forced OCR retry ≈ **1.2–2.5s wall per read**; a copy-verify-readback field write = 2–3 execs = **3–7s
pure overhead per field**.

**Fix:** the existing `ga4-agent.ps1` TcpListener :8765 as the **sole** session-1 channel → **~1–5ms**
per op (2 orders of magnitude), and it **never blanks the framebuffer** (touches nothing in the display
path), so reads and screenshots stop being mutually destructive. Clipboard verification becomes a push
(`AddClipboardFormatListener`) with owner attached. Single long-lived process = stable HWND cache
resolved once.

Other measured/structural wins:
- **OCR grounding cache** keyed on frame dHash — re-OCR static chrome (tab labels, captions) only on real
  layout change; saves a Vision pass per action.
- **`send-key-event -j` batching** — one invocation per field's scancodes, amortizes process-spawn.
- **Sub-region OCR** — set `regionOfInterest` to the field/dialog box, not the full 1456×1268 frame —
  faster, higher effective resolution, fewer false tokens.
- **Measurement harness** — wrap every channel op in a timer → per-op histograms; proves the agent
  migration and catches regressions.

---

## 13. Security improvements

- **Loopback-only bind** — `TcpListener` on `127.0.0.1:8765`, never `0.0.0.0`; verify no Parallels
  host↔guest forward maps 8765; reach it only via the host-only adapter.
- **Per-session bearer token** — random token at agent launch handed out-of-band (file readable only by
  the launching user); every JSON line carries it; rotate per launch. Launch via the existing
  `schtasks /it InteractiveToken` precedent (production `GA4_PDF_Watcher`).
- **Single-flight / serialized commands** — one command at a time under an explicit lock; two writers =
  corruption; reject overlaps, don't queue blind input. Lock spans host+guest so cliclick and human
  clicks can't interleave on the same field.
- **No stored credentials in the agent** — it only does SendInput/screenshot/window/clipboard reads; all
  business logic + Neon pool stay host-side. Compromise = keystroke injection into a foreground window,
  not credential theft.
- **Financial-action audit trail** — every Issue writes an immutable log record + a separate append-only
  signed line `{N, reg, customer, total, ts, operator=automation, evidence_hash}` — the reconciliation
  anchor against GA4's Sales-Issued PDF.
- **Human co-use guarding** — the mouse gate only opens when a human is present (Mac unlocked + Parallels
  frontmost); before any click stage, the foreground/heartbeat check confirms GA4 is still front — if the
  human alt-tabbed, **abort the click, don't fight for focus**; show a visible "automation running"
  indicator so the human doesn't type into the same draft.

---

## 14. Transaction improvements

- **Idempotency on `N`** — every side-effectful stage keyed on the pre-reserved number; re-derivable from
  the screen (§10).
- **Pre-commit verification** — penny-gate + per-field clipboard read-backs + no-unexpected-modal, **all
  in the same settled frame** immediately before the Issue keystroke.
- **Irreversible-action guard** — Issue and delete get single-activation/`single:true`; a pHash-stable
  settled frame is required before firing; kill-switch checked at stage boundaries (never mid-Issue).
- **Durable journal** — SQLite in WAL mode (concurrent Mac-orchestrator + session-1 reader) with the
  **outbox / idempotent-consumer** pattern: write "intent to issue N" + pool reservation atomically;
  states reserved→filled→verified→stamped; dedupe by eventId so a crash mid-issue never double-issues or
  orphans a draft.

---

## 15. Architecture scorecard

Scored 1–5 (5 best). "Headless" = works Mac-locked/backgrounded. "Home" = deployable on Win11 Home
without admin/RDP.

| Option | Reliability | Determinism | Effort | Headless | On-Home | Maintainability |
|---|---|---|---|---|---|---|
| **Current hybrid** (exec reads, cliclick, OCR poll) | 2 | 2 | — (built) | 1 | 5 | 3 |
| **Persistent-agent hybrid** (TCP agent reads + transactional clipboard + WinEvent dialogs + UNICODE keys; cliclick for residual clicks) | **4** | **4** | 2 (agent exists) | 3 (keys/reads headless; clicks still gated) | **5** | 4 |
| **+ SDK headless mouse** (agent hybrid + `PrlDevMouse_SetPos`) | **5** | **5** | 3 (one spike) | **5** | **5** | 4 |
| Windows-agent-only (all logic in-guest) | 3 | 3 | 4 | 3 | 4 | 2 (splits logic from Neon/Mac) |
| Mac-agent-only (no session-1 helper) | 2 | 2 | 3 | 1 | 5 | 3 (loses Win32 clipboard/window proofs) |
| Shared-queue (msg broker host↔guest) | 3 | 3 | 4 | 3 | 3 | 3 (broker on a never-rebooting VM) |
| HTTP (vs line-JSON TCP) | 3 | 3 | 3 | 3 | 5 | 3 (no win over TCP locally) |
| SQLite journal (as the transaction spine, not transport) | +1 to whichever it augments | +1 | 2 | n/a | 5 | 4 |
| gRPC RPC | 3 | 3 | 4 | 3 | 4 | 2 (~10× slower than UDS locally, codegen tax) |

**Recommended winner:** **Persistent-agent hybrid now**, upgraded to **+ SDK headless mouse** if the §5
spike lands. Add the **SQLite outbox journal** as the transaction spine regardless. Keep the **line-JSON
TcpListener** — don't add gRPC/HTTP. This maximizes reliability/determinism/headless while staying
deployable on Win11 Home and reusing the already-built agent.

---

## 16. IMMEDIATE high-value wins (ship this week) — ranked

1. **Transactional-clipboard verifier** `[SAFE-NOW]` — implement seq#Δ + owner==GA4 + nonce (§7).
   *First step:* fold the `Clip` `Add-Type` block into `ga4-agent.ps1`, replace every `Get-Clipboard`
   with `verifyFieldEquals`. Kills the stale-read class today.
2. **Route session-1 reads through the persistent agent** `[agent exists]` — stop the exec tax +
   frame-blackout. *First step:* point clipboard/NumLock/window reads at TCP :8765; keep `prlctl exec`
   only as agent-down fallback. Measure before/after with the timing harness.
3. **UNICODE SendInput for field text** — *First step:* add a `type_unicode` verb to the agent; switch
   field fills off scancodes; keep VK chords + extended nav.
4. **WinEvent dialog trip-wire + `#32770` classifier** — *First step:* register `SetWinEventHook` in the
   agent's message loop, classify each new top-level by `GetClassName`, press `#32770` buttons via UIA
   Invoke by `.Name`; keep the "never Return on Open-Document" policy.
5. **pHash settle-gate + evidence stamp** `[SAFE-NOW]` — *First step:* add dHash to the Swift capture
   binary; require two consecutive frames Hamming ≤2 before any act; log before/after hashes per
   irreversible action.
6. **SQLite outbox journal on `N`** — *First step:* WAL DB with reserved→filled→verified→stamped states,
   dedupe by eventId; reconcile-on-boot from the screen.

---

## 17. Medium-term improvements

- Persistent-agent **push clipboard** (`AddClipboardFormatListener`) + **stable HWND cache** + **OCR
  grounding cache** keyed on frame hash.
- **Anchor-based layout fingerprinting** — per-screen expected static labels + normalized bboxes; assert
  before any write to catch "wrong record/layout/tab"; pair with a pHash of an anchor sub-region as a
  fast pre-check.
- **Multi-frame OCR consensus** (≥2 of 3 on the settled frame) + `usesLanguageCorrection=false` for
  regs/£ totals + `customWords` hints + sub-region ROI.
- **Full structured JSON logging + content-addressed frame store + replay harness** (§11); per-op latency
  histograms as the regression/freeze early-warning.
- **Keyboard-first navigation map** — enumerate every field reachable without the mouse to shrink the
  gated surface.

---

## 18. Long-term roadmap

- **Land the SDK headless mouse** (§5) → retire the Mac-unlocked/Parallels-frontmost precondition;
  unattended overnight issuing becomes possible.
- **Full unattended pipeline** guarded by the §6 watchdog + §13 kill-switch + §14 idempotency —
  reserve-fill-verify-issue-stamp with human review only on desync.
- **Native-menu + `#32770`-dialog actuation as primary**, OCR/cliclick as fallback — most of the
  workflow becomes semantic and mouse-free.
- **Snapshot/clone-based CI** — a throwaway `Win11Manual` clone to spike drivers (Interception) and
  regression-test the writer against scratch drafts, never live records.

---

## 19. Experimental ideas

- **Headless mouse via `PrlDevMouse_SetPos`** `[SPIKE, high-upside]` — the prize; ~1 experiment decides
  it (§5). Falsifiable cheaply if Desktop-for-Mac stubs `ConnectToVm`.
- **`--smart-mouse-optimize off`** as a variable *if* the SDK spike shows game/smart-mouse capture
  interaction.
- **Interception on a VM clone** `[SPIKE, high-blast-radius]` — guest-driver injection as the fallback
  gate escape; clone-only, admin+reboot.
- **UIA-event-driven modal *control*** (`WindowOpenedEvent` handing you the element to Invoke) — beyond
  detection, full mouse-free dialog handling for the `#32770` class.
- **Rule out permanently:** ViGEm/vJoy (gamepad-only), AHK SendPlay (unsupported Win11), in-guest
  SendInput mouse (gated), RDP (no host on Home).

---

## 20. Anything overlooked

- **The native Win32 menu bar `[PROVEN: GetMenu → 8 items]`** is a *second* semantic surface most
  analyses miss — a mouse-free command actuator alongside `#32770` dialog buttons. Worth mapping which
  GA4 operations are reachable via menu commands vs. only via canvas clicks.
- **406-day uptime `[PROVEN]`** reframes hardening: never assume a reboot clears anything; the agent must
  be leak-safe over months; wedged-modal recovery must be in-place.
- **UIPI silent-failure** — if GA4 ever runs elevated relative to the agent, every SendInput silently
  no-ops with no error. Enforce equal integrity; the clipboard ACK is the detector.
- **CPInterceptor stale-bleed** (verified live) is *exactly* what the owner==GA4 check neutralizes — make
  that check mandatory on every read, not optional.
- **The penny-gate must sit in the same settled frame as the Issue keystroke** — any intervening
  `prlctl exec` blanks/refreshes state and breaks the atomicity of "verified total → issue." A subtle
  ordering constraint the current exec-per-read model violates; the persistent agent fixes it as a side
  effect.
- **Format hygiene on grid copies** — GA4 portal/grid Ctrl+C can carry CF_HTML/CF_RTF; a plain-field
  paste of that can misbehave. Require CF_UNICODETEXT and read *that* format explicitly.
- **Honest uncertainty:** the headless-mouse SDK path is a **lead backed by strong on-box evidence
  (exported symbols, compiled error codes, root daemon, ungated keyboard sibling)** — not a promise. The
  connect-returns-OK checkpoint on Desktop-for-Mac is the single gate. Everything in §1–4, §6–14, §16–17
  is deterministic and shippable **without** it; the mouse spike is upside, not a dependency.
