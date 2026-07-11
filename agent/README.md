# GA4 in-guest agent — headless click path

## Why this exists
Parallels **gates all guest mouse input** (`SetCursorPos`, `mouse_event`, `SendInput`,
`PostMessage` — all proven no-ops) whenever the Parallels window is **not focused** on the Mac.
Keyboard, clipboard, and `prlctl capture` screenshots ride ungated channels and already work
headless. So to click GA4 (FileMaker) while the Mac user works elsewhere, the click must be
generated inside a session that **bypasses Parallels' console-mouse layer**:

- **RDP session** — its own display + input queue, independent of the Parallels window. ← primary
- **Truly headless VM** — no window, so maybe no "focus" to lose. ← quick alt to try
- (FileMaker ignores `PostMessage` synthetic clicks regardless — it's a custom MFC canvas.)

`ga4-agent.ps1` is the process that runs **inside that session** and is driven over TCP by the
Mac MCP server. Zero-install (Windows PowerShell 5.1 + .NET). Screenshots use in-session GDI
capture (an RDP session's screen is NOT visible to `prlctl capture`, which only sees the console).

## Facts (already established — don't re-derive)
- Guest resolution observed **1456×1268** but **query it live** (`{"cmd":"res"}`) — it drifts.
- Image(1200-wide screenshot) → guest pixels = **× (liveWidth / 1200)**, uniform both axes.
- GA4 top window class `Afx:00D70000:2`. GA4 is single-user "Standalone" → runs in any one session.
- Reversible smoke-test target: **Archives tab** at image (155,141) → send `{"cmd":"click","x":155,"y":141,"w":1200}`; success = the list switches from "Invoices In Progress" to "Document Archives".

## Run it
```powershell
powershell -ExecutionPolicy Bypass -File C:\GA4Scripts\ga4-agent.ps1 -Port 8765
```
Optional shared secret: `-Token <secret>` (then every request must include `"token":"<secret>"`).

## Protocol (line-delimited JSON over TCP, one request line → one response line)
- `{"cmd":"ping"}` → `{"ok":true,"pong":true}`
- `{"cmd":"res"}` → `{"ok":true,"screenW":1456,"screenH":1268}`
- `{"cmd":"screenshot"}` → `{"ok":true,"imgW":1200,"imgH":..,"screenW":..,"screenH":..,"png":"<base64>"}`
- `{"cmd":"click|double|right|move","x":155,"y":141,"w":1200}`
- `{"cmd":"type","text":"46473"}`  (Unicode SendInput)
- `{"cmd":"key","combo":"ctrl+a"}`
- `{"cmd":"paste","x":200,"y":365,"w":1200,"text":"CASTROL 5W/30","selectAll":true}`

## THE DECISIVE TEST (do this first)
1. `winver` — confirm **Windows Pro/Enterprise** (needed for incoming RDP).
2. Enable Remote Desktop; ensure a persistent interactive session that won't lock on disconnect
   (`tscon <sessionId> /dest:console`, or an RDP-loopback + keep-alive).
3. Make sure **GA4 is running in that session**, then start `ga4-agent.ps1` in it.
4. From another machine (or loopback), with the Mac showing some **other** app frontmost, send:
   `{"cmd":"click","x":155,"y":141,"w":1200}` then `{"cmd":"screenshot"}`.
5. **If the screenshot shows "Document Archives" → the RDP path defeats the gate.** Report back:
   Windows edition, whether the click registered, and the agent's reachable host:port.

## Then (Mac side, mine): rewire `src/tools/*.ts` clicks from `cliclick` → this agent behind
`GA4_AGENT_URL`. Prereq for unattended runs regardless: fix `src/tools/invoice.ts`
(multi-part parts scramble, reg double-paste garble, `issue_invoice` not completing).
See memory: `ga4-headless-transport`, `ga4-writeback-backlog`.
