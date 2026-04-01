param([string]$Text)

# Set clipboard to the text, then simulate Ctrl+V to paste
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($Text)
Start-Sleep -Milliseconds 100

# Simulate Ctrl+V using user32.dll keybd_event
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KeyboardHelper {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public const byte VK_CONTROL = 0x11;
    public const byte VK_V = 0x56;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static void Paste() {
        keybd_event(VK_CONTROL, 0, 0, 0);
        keybd_event(VK_V, 0, 0, 0);
        System.Threading.Thread.Sleep(50);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    }
}
"@

[KeyboardHelper]::Paste()
Start-Sleep -Milliseconds 100
Write-Output "Typed via clipboard paste: $Text"
