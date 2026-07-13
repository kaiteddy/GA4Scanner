# SAFE Type - Transactional Clipboard with Verification
# Replaces type.ps1 with bulletproof clipboard handling

param(
    [Parameter(Mandatory=$true)]
    [string]$Text,

    [int]$MaxRetries = 3
)

Add-Type -AssemblyName System.Windows.Forms

# Clipboard sequence number API
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ClipboardAPI {
    [DllImport("user32.dll")]
    public static extern int GetClipboardSequenceNumber();
}
"@

# Keyboard API for Ctrl+V
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

# Attempt transactional clipboard set
for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
    # Get sequence number BEFORE
    $seqBefore = [ClipboardAPI]::GetClipboardSequenceNumber()

    # Set clipboard
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
    } catch {
        Write-Error "Clipboard set failed (attempt $attempt): $_"
        Start-Sleep -Milliseconds 200
        continue
    }

    Start-Sleep -Milliseconds 150

    # Get sequence number AFTER
    $seqAfter = [ClipboardAPI]::GetClipboardSequenceNumber()

    # Verify sequence number increased (proof clipboard was updated)
    if ($seqAfter -le $seqBefore) {
        Write-Error "Clipboard sequence unchanged (attempt $attempt) - CPInterceptor contamination detected"
        Start-Sleep -Milliseconds 300
        continue
    }

    # Verify content
    $readBack = [System.Windows.Forms.Clipboard]::GetText()
    if ($readBack -ne $Text) {
        Write-Error "Clipboard content mismatch (attempt $attempt): expected '$Text', got '$readBack'"
        Start-Sleep -Milliseconds 300
        continue
    }

    # SUCCESS - Clipboard verified, now paste
    [KeyboardHelper]::Paste()
    Start-Sleep -Milliseconds 100

    Write-Output "SAFE: Typed via verified clipboard (seq +$($seqAfter - $seqBefore)): $Text"
    exit 0
}

# All retries failed
Write-Error "FAILED: Could not safely set clipboard after $MaxRetries attempts"
exit 1
