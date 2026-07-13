# GA4 Automation Diagnostics Script
# Tests core operations to identify flakiness sources

Write-Output "=== GA4 AUTOMATION DIAGNOSTICS ==="
Write-Output ""

# Test 1: Window Detection
Write-Output "[TEST 1] Window Detection"
try {
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Win32 {
            [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();

            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        }
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
"@

    $hwnd = [Win32]::FindWindow($null, "Garage Assistant GA4 - [v4.046 Standalone]")
    if ($hwnd -ne [IntPtr]::Zero) {
        $rect = New-Object RECT
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        Write-Output "  ✓ GA4 window found: $hwnd"
        Write-Output "    Position: ($($rect.Left), $($rect.Top))"
        Write-Output "    Size: $($rect.Right - $rect.Left) x $($rect.Bottom - $($rect.Top))"

        $foreground = [Win32]::GetForegroundWindow()
        $isForeground = $hwnd -eq $foreground
        Write-Output "    Foreground: $isForeground"
    } else {
        Write-Output "  ✗ GA4 window NOT found"
    }
} catch {
    Write-Output "  ✗ Error: $_"
}
Write-Output ""

# Test 2: Clipboard Operations
Write-Output "[TEST 2] Clipboard Operations"
try {
    Add-Type -AssemblyName System.Windows.Forms

    # Save current clipboard
    $original = [System.Windows.Forms.Clipboard]::GetText()

    # Test write
    $testText = "DIAGNOSTIC_TEST_$(Get-Date -Format 'HHmmss')"
    [System.Windows.Forms.Clipboard]::SetText($testText)
    Start-Sleep -Milliseconds 100

    # Test read
    $readBack = [System.Windows.Forms.Clipboard]::GetText()
    if ($readBack -eq $testText) {
        Write-Output "  ✓ Clipboard write/read works"
    } else {
        Write-Output "  ✗ Clipboard mismatch: wrote '$testText', read '$readBack'"
    }

    # Restore original
    if ($original) {
        [System.Windows.Forms.Clipboard]::SetText($original)
    }
} catch {
    Write-Output "  ✗ Error: $_"
}
Write-Output ""

# Test 3: Mouse Position Query
Write-Output "[TEST 3] Mouse Position"
try {
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Mouse {
            [DllImport("user32.dll")]
            public static extern bool GetCursorPos(out POINT lpPoint);
        }
        public struct POINT {
            public int X;
            public int Y;
        }
"@

    $point = New-Object POINT
    [Mouse]::GetCursorPos([ref]$point) | Out-Null
    Write-Output "  ✓ Current cursor: ($($point.X), $($point.Y))"
} catch {
    Write-Output "  ✗ Error: $_"
}
Write-Output ""

# Test 4: Screen Resolution
Write-Output "[TEST 4] Screen Info"
try {
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $width = $screen.Bounds.Width
    $height = $screen.Bounds.Height
    Write-Output "  Resolution: $width x $height"
    $workWidth = $screen.WorkingArea.Width
    $workHeight = $screen.WorkingArea.Height
    Write-Output "  Working Area: $workWidth x $workHeight"
    $bpp = $screen.BitsPerPixel
    Write-Output "  Bits Per Pixel: $bpp"
} catch {
    Write-Output "  Error in Test 4"
}
Write-Output ""

Write-Output "DIAGNOSTICS COMPLETE"
