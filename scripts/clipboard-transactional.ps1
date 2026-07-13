# Transactional Clipboard with Sequence Number Verification
# Prevents Parallels CPInterceptor contamination

param(
    [Parameter(Mandatory=$true)]
    [string]$Text,

    [int]$MaxRetries = 3
)

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClipboardAPI {
    [DllImport("user32.dll")]
    public static extern int GetClipboardSequenceNumber();
}
"@

Write-Host "=== TRANSACTIONAL CLIPBOARD ===" -ForegroundColor Cyan
Write-Host "Setting: '$Text'" -ForegroundColor Gray
Write-Host ""

for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
    Write-Host "Attempt $attempt/$MaxRetries..." -ForegroundColor Yellow

    # Get sequence number BEFORE setting clipboard
    $seqBefore = [ClipboardAPI]::GetClipboardSequenceNumber()
    Write-Host "  Seq BEFORE: $seqBefore" -ForegroundColor Gray

    # Set clipboard
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
    } catch {
        Write-Host "  ERROR: Failed to set clipboard - $_" -ForegroundColor Red
        Start-Sleep -Milliseconds 200
        continue
    }

    Start-Sleep -Milliseconds 150

    # Get sequence number AFTER
    $seqAfter = [ClipboardAPI]::GetClipboardSequenceNumber()
    Write-Host "  Seq AFTER:  $seqAfter" -ForegroundColor Gray

    # Verify sequence number increased
    if ($seqAfter -le $seqBefore) {
        Write-Host "  FAIL: Sequence number did not increment!" -ForegroundColor Red
        Write-Host "        Clipboard was not updated (CPInterceptor contamination?)" -ForegroundColor Red
        Start-Sleep -Milliseconds 300
        continue
    }

    # Verify content
    $readBack = [System.Windows.Forms.Clipboard]::GetText()
    if ($readBack -ne $Text) {
        Write-Host "  FAIL: Content mismatch!" -ForegroundColor Red
        Write-Host "        Expected: '$Text'" -ForegroundColor Red
        Write-Host "        Got:      '$readBack'" -ForegroundColor Red
        Start-Sleep -Milliseconds 300
        continue
    }

    # SUCCESS
    Write-Host "  SUCCESS: Clipboard verified" -ForegroundColor Green
    Write-Host "    Seq delta: +$($seqAfter - $seqBefore)" -ForegroundColor Green
    Write-Host "    Content: '$readBack'" -ForegroundColor Green
    return @{
        Success = $true
        SequenceBefore = $seqBefore
        SequenceAfter = $seqAfter
        Delta = $seqAfter - $seqBefore
        Content = $readBack
    }
}

# All retries failed
Write-Host ""
Write-Host "FAILED after $MaxRetries attempts" -ForegroundColor Red
return @{
    Success = $false
}
