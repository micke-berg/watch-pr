param([string]$AppId = 'WatchPr.PRWatch', [string]$Name = 'PR Watch')
$ErrorActionPreference = 'Stop'

# register-toast-app.ps1 — gives watch-pr's Windows toasts their own name and icon. An unpackaged
# app only gets that from a Start-menu shortcut carrying its AppUserModelID; without one, Windows
# shows the raw id and no icon. Called by notify.ps1 when the shortcut is missing; safe to re-run.
$icoPath = Join-Path $PSScriptRoot 'icon.ico'
$pngPath = Join-Path $PSScriptRoot 'icon-192.png'
$lnkPath = Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"

# A Windows .ico may hold a PNG as-is: 6-byte header + one 16-byte directory entry + the PNG bytes.
if (-not (Test-Path $icoPath)) {
    $png = [IO.File]::ReadAllBytes($pngPath)
    $ms = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter($ms)
    $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
    $w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
    $w.Write($png); $w.Flush()
    [IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
}

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class ToastShortcut {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c, IntPtr d, uint fl);
        void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int c);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int c);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int c);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
        void GetHotkey(out short h); void SetHotkey(short h);
        void GetShowCmd(out int c); void SetShowCmd(int c);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int c, out int i);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r);
        void Resolve(IntPtr h, uint f);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint c); void GetAt(uint i, out PropertyKey k);
        void GetValue(ref PropertyKey k, out PropVariant v);
        void SetValue(ref PropertyKey k, ref PropVariant v); void Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }

    public static void Create(string lnk, string target, string args, string icon, string appId) {
        var link = (IShellLinkW)new CShellLink();
        link.SetPath(target); link.SetArguments(args); link.SetIconLocation(icon, 0);
        var store = (IPropertyStore)link;
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var value = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
        store.SetValue(ref key, ref value); store.Commit();
        ((IPersistFile)link).Save(lnk, true);
        Marshal.FreeCoTaskMem(value.p);
    }
}
'@

# The shortcut opens the dashboard; its real job is carrying the app id, name and icon.
[ToastShortcut]::Create($lnkPath, (Join-Path $PSScriptRoot 'dashboard.cmd'), '', $icoPath, $AppId)
$lnkPath
