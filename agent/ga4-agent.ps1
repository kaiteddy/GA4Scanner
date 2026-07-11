<#
  ga4-agent.ps1 — in-guest input + capture agent for GA4 automation.

  WHY THIS EXISTS: Parallels gates GUEST MOUSE input (SetCursorPos/mouse_event/
  SendInput/PostMessage all no-op) whenever the Parallels window is NOT focused on
  the Mac. Keyboard/clipboard/screenshot ride ungated channels. To click GA4 while
  the Mac user works elsewhere, the click must be generated inside a session that
  bypasses Parallels' console-mouse layer — i.e. an RDP session (its own input
  queue + display), or a truly headless VM. This agent is what runs INSIDE that
  session and is driven over TCP by the Mac MCP server.

  ZERO INSTALL: Windows PowerShell 5.1 + .NET Framework only. Drop in C:\GA4Scripts
  and run. Screenshots use in-session GDI capture (works in an RDP session, unlike
  prlctl capture which only sees the console framebuffer).

  PROTOCOL: line-delimited JSON over TCP. One request line -> one response line.
    -> {"cmd":"click","x":155,"y":141,"w":1200}        (image coords + the width
                                                          they were measured at)
    -> {"cmd":"double", ...}  {"cmd":"right", ...}  {"cmd":"move", ...}
    -> {"cmd":"paste","x":200,"y":365,"w":1200,"text":"CASTROL 5W/30","selectAll":true}
    -> {"cmd":"type","text":"46473"}
    -> {"cmd":"key","combo":"ctrl+a"}
    -> {"cmd":"screenshot"}                              -> {"ok":true,"imgW":1200,"imgH":..,"screenW":1456,"screenH":1268,"png":"<base64>"}
    -> {"cmd":"res"}                                     -> {"ok":true,"screenW":..,"screenH":..}
    -> {"cmd":"ping"}                                    -> {"ok":true,"pong":true}

  Coordinates are scaled from the measurement width `w` (default 1200) to the LIVE
  guest resolution at request time — never hardcoded (current res observed 1456x1268
  but MUST be queried; it drifts with the Parallels window / headless mode).

  Usage:  powershell -ExecutionPolicy Bypass -File C:\GA4Scripts\ga4-agent.ps1 -Port 8765
#>
param(
  [int]$Port = 8765,
  [string]$Bind = "0.0.0.0",
  [string]$Token = ""   # optional shared secret; if set, every request must include "token"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Native {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

  const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;
  const uint MOVE=0x0001, ABSOLUTE=0x8000, VIRTUALDESK=0x4000, LDOWN=0x0002, LUP=0x0004, RDOWN=0x0008, RUP=0x0010;
  const uint KEYUP=0x0002, UNICODE=0x0004;

  static int Size = Marshal.SizeOf(typeof(INPUT));
  static INPUT M(uint flags,int dx,int dy){ INPUT i=new INPUT(); i.type=INPUT_MOUSE; i.U.mi.dx=dx; i.U.mi.dy=dy; i.U.mi.dwFlags=flags; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags){ INPUT i=new INPUT(); i.type=INPUT_KEYBOARD; i.U.ki.wVk=vk; i.U.ki.wScan=scan; i.U.ki.dwFlags=flags; return i; }

  public static int ScreenW(){ return GetSystemMetrics(0); }
  public static int ScreenH(){ return GetSystemMetrics(1); }

  static void AbsXY(int x, int y, out int ax, out int ay){
    int W=GetSystemMetrics(0), H=GetSystemMetrics(1);
    if(W<2)W=2; if(H<2)H=2;
    ax=(x*65535)/(W-1); ay=(y*65535)/(H-1);
  }
  public static void Move(int x,int y){ int ax,ay; AbsXY(x,y,out ax,out ay);
    INPUT[] a={ M(MOVE|ABSOLUTE,ax,ay) }; SendInput(1,a,Size); }
  public static void Click(int x,int y,int button){ int ax,ay; AbsXY(x,y,out ax,out ay);
    uint dn = button==2?RDOWN:LDOWN, up = button==2?RUP:LUP;
    INPUT[] a={ M(MOVE|ABSOLUTE,ax,ay), M(dn,0,0), M(up,0,0) };
    SendInput((uint)a.Length,a,Size); }
  public static void DoubleClick(int x,int y){ Click(x,y,1); System.Threading.Thread.Sleep(70); Click(x,y,1); }

  public static void TypeUnicode(string s){
    var list = new List<INPUT>();
    foreach(char c in s){ list.Add(K(0,(ushort)c,UNICODE)); list.Add(K(0,(ushort)c,UNICODE|KEYUP)); }
    if(list.Count>0){ var arr=list.ToArray(); SendInput((uint)arr.Length,arr,Size); }
  }
  public static void KeyChord(ushort[] vks){
    var list = new List<INPUT>();
    foreach(var vk in vks) list.Add(K(vk,0,0));                 // press in order
    for(int i=vks.Length-1;i>=0;i--) list.Add(K(vks[i],0,KEYUP)); // release reverse
    var arr=list.ToArray(); SendInput((uint)arr.Length,arr,Size);
  }
}
"@

# --- virtual-key map for key chords ---------------------------------------
$VK = @{
  "ctrl"=0x11; "control"=0x11; "shift"=0x10; "alt"=0x12;
  "enter"=0x0D; "return"=0x0D; "tab"=0x09; "escape"=0x1B; "esc"=0x1B;
  "space"=0x20; "backspace"=0x08; "delete"=0x2E; "del"=0x2E;
  "left"=0x25; "up"=0x26; "right"=0x27; "down"=0x28;
  "home"=0x24; "end"=0x23; "pageup"=0x21; "pagedown"=0x22;
  "f1"=0x70;"f2"=0x71;"f3"=0x72;"f4"=0x73;"f5"=0x74;"f6"=0x75;"f7"=0x76;"f8"=0x77;"f9"=0x78;"f10"=0x79;"f11"=0x7A;"f12"=0x7B
}
foreach($c in "abcdefghijklmnopqrstuvwxyz".ToCharArray()){ $VK["$c"] = [int][char]([string]$c).ToUpper() }
foreach($d in "0123456789".ToCharArray()){ $VK["$d"] = [int][char]$d }

function Resolve-Chord([string]$combo){
  $parts = $combo.ToLower().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $vks = @()
  foreach($p in $parts){ if(-not $VK.ContainsKey($p)){ throw "unknown key '$p'" }; $vks += [uint16]$VK[$p] }
  return ,([uint16[]]$vks)
}

# image(measurement-width w) -> live guest pixels (uniform scale, aspect preserved)
function Scale-XY([double]$x,[double]$y,[double]$w){
  if(-not $w -or $w -le 0){ $w = 1200 }
  $sw = [Native]::ScreenW()
  $f = $sw / $w
  return @([int][math]::Round($x*$f), [int][math]::Round($y*$f))
}

function Capture-Screen(){
  $sw=[Native]::ScreenW(); $sh=[Native]::ScreenH()
  $bmp = New-Object System.Drawing.Bitmap $sw, $sh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0,0,0,0, (New-Object System.Drawing.Size $sw,$sh))
  $g.Dispose()
  $tw = 1200; $th = [int][math]::Round($sh * $tw / $sw)
  $rez = New-Object System.Drawing.Bitmap $tw, $th
  $g2 = [System.Drawing.Graphics]::FromImage($rez)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp,0,0,$tw,$th); $g2.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $rez.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
  $b64 = [Convert]::ToString([Convert]::ToBase64String($ms.ToArray()))
  $ms.Dispose(); $bmp.Dispose(); $rez.Dispose()
  return @{ imgW=$tw; imgH=$th; screenW=$sw; screenH=$sh; png=$b64 }
}

function Set-Clip([string]$text){
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 30
}

function Handle([object]$req){
  if($Token -ne "" -and $req.token -ne $Token){ return @{ ok=$false; error="bad token" } }
  switch ($req.cmd) {
    "ping"       { return @{ ok=$true; pong=$true } }
    "res"        { return @{ ok=$true; screenW=[Native]::ScreenW(); screenH=[Native]::ScreenH() } }
    "screenshot" { $s = Capture-Screen; $s.ok=$true; return $s }
    "move"       { $p = Scale-XY $req.x $req.y $req.w; [Native]::Move($p[0],$p[1]); return @{ ok=$true; guestX=$p[0]; guestY=$p[1] } }
    "click"      { $p = Scale-XY $req.x $req.y $req.w; [Native]::Click($p[0],$p[1],1); return @{ ok=$true; guestX=$p[0]; guestY=$p[1] } }
    "right"      { $p = Scale-XY $req.x $req.y $req.w; [Native]::Click($p[0],$p[1],2); return @{ ok=$true; guestX=$p[0]; guestY=$p[1] } }
    "double"     { $p = Scale-XY $req.x $req.y $req.w; [Native]::DoubleClick($p[0],$p[1]); return @{ ok=$true; guestX=$p[0]; guestY=$p[1] } }
    "type"       { [Native]::TypeUnicode([string]$req.text); return @{ ok=$true } }
    "key"        { $vks = Resolve-Chord ([string]$req.combo); [Native]::KeyChord($vks); return @{ ok=$true } }
    "paste"      {
                   $p = Scale-XY $req.x $req.y $req.w
                   [Native]::Click($p[0],$p[1],1); Start-Sleep -Milliseconds 40
                   $sel = $true; if($req.PSObject.Properties.Name -contains "selectAll"){ $sel = [bool]$req.selectAll }
                   if($sel){ [Native]::KeyChord((Resolve-Chord "ctrl+a")); Start-Sleep -Milliseconds 20 }
                   Set-Clip ([string]$req.text)
                   [Native]::KeyChord((Resolve-Chord "ctrl+v"))
                   return @{ ok=$true; guestX=$p[0]; guestY=$p[1] }
                 }
    default      { return @{ ok=$false; error="unknown cmd '$($req.cmd)'" } }
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($Bind), $Port)
$listener.Start()
Write-Host "ga4-agent listening on ${Bind}:${Port}  (screen $([Native]::ScreenW())x$([Native]::ScreenH()))"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
      $writer.AutoFlush = $true
      while ($null -ne ($line = $reader.ReadLine())) {
        if ($line.Trim() -eq "") { continue }
        $resp = $null
        try   { $req = $line | ConvertFrom-Json; $resp = Handle $req }
        catch { $resp = @{ ok=$false; error=("$($_.Exception.Message)") } }
        $writer.WriteLine(($resp | ConvertTo-Json -Compress -Depth 6))
      }
    } catch { }
    finally { $client.Close() }
  }
} finally { $listener.Stop() }
