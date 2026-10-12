$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class HarnessDesktop {
    [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int horizontal, vertical; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KeyInput { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyInput keyboard; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int horizontal, vertical; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    public static int ForbiddenPid;
    public static void Protect(IntPtr handle) { uint process; GetWindowThreadProcessId(handle, out process); if (process == ForbiddenPid) throw new Exception("禁止操纵青禾 Studio 自身窗口及审批界面"); }
    public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); } }
    public static void Guard() { if ((GetAsyncKeyState(27) & 0x8000) != 0) throw new Exception("Esc 已按下，停止桌面操作"); }
    static void Send(Input[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length) throw new Exception("Windows 拒绝输入；不支持锁屏、UAC 或更高权限窗口"); }
    static Input Key(ushort code, bool up, bool unicode) { Input input = new Input(); input.type = 1; input.data.keyboard.key = unicode ? (ushort)0 : code; input.data.keyboard.scan = unicode ? code : (ushort)0; input.data.keyboard.flags = (uint)((up ? 2 : 0) | (unicode ? 4 : code >= 33 && code <= 46 || code == 91 ? 1 : 0)); return input; }
    static Input Mouse(uint flags, uint data, int horizontal, int vertical) { Input input = new Input(); input.data.mouse.flags = flags; input.data.mouse.data = data; input.data.mouse.horizontal = horizontal; input.data.mouse.vertical = vertical; return input; }
    public static string Title(IntPtr handle) { StringBuilder text = new StringBuilder(512); GetWindowText(handle, text, text.Capacity); return text.ToString(); }
    public static object Windows() {
        List<object> windows = new List<object>();
        EnumWindows(delegate(IntPtr handle, IntPtr parameter) { string title = Title(handle); if (IsWindowVisible(handle) && title.Length > 0 && windows.Count < 100) windows.Add(new { windowId = handle.ToInt64().ToString(), title = title, foreground = handle == GetForegroundWindow() }); return true; }, IntPtr.Zero);
        return windows;
    }
    public static void Foreground(string expected) { Guard(); if (GetForegroundWindow().ToInt64().ToString() != expected) throw new Exception("前台窗口已变化，请重新截图或明确 focus 后再操作"); }
    public static void Focus(long value) { Guard(); IntPtr handle = new IntPtr(value); if (!IsWindowVisible(handle)) throw new Exception("窗口已关闭或不可见"); if (IsIconic(handle)) ShowWindow(handle, 9); SetForegroundWindow(handle); Thread.Sleep(100); Foreground(value.ToString()); }
    public static object Capture() {
        Rectangle bounds = SystemInformation.VirtualScreen;
        if (bounds.Width < 1 || bounds.Height < 1 || (long)bounds.Width * bounds.Height > 100000000) throw new Exception("桌面尺寸不可用或过大");
        IntPtr foreground = GetForegroundWindow();
        using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height)) {
            using (Graphics graphics = Graphics.FromImage(bitmap)) { graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size); }
            double scale = Math.Min(1.0, 1600.0 / Math.Max(bounds.Width, bounds.Height));
            int width = Math.Max(1, (int)Math.Round(bounds.Width * scale)), height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
            using (Bitmap preview = new Bitmap(bitmap, width, height)) using (MemoryStream stream = new MemoryStream()) {
                preview.Save(stream, ImageFormat.Jpeg);
                return new { width = width, height = height, bounds = new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height }, windowId = foreground.ToInt64().ToString(), title = Title(foreground), image = new { mimeType = "image/jpeg", data = Convert.ToBase64String(stream.ToArray()) } };
            }
        }
    }
    public static void Click(int horizontal, int vertical, string button, int count) {
        Guard(); Rectangle bounds = SystemInformation.VirtualScreen;
        if (!bounds.Contains(horizontal, vertical)) throw new Exception("点击坐标已不在当前桌面内，请重新截图");
        Protect(WindowFromPoint(new Point { horizontal = horizontal, vertical = vertical }));
        Send(new Input[] { Mouse(0xC001, 0, (int)((long)(horizontal - bounds.Left) * 65535 / Math.Max(1, bounds.Width - 1)), (int)((long)(vertical - bounds.Top) * 65535 / Math.Max(1, bounds.Height - 1))) });
        uint down = button == "right" ? 8u : 2u, up = button == "right" ? 16u : 4u;
        for (int index = 0; index < count; index++) { Guard(); Send(new Input[] { Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0) }); if (index + 1 < count) Thread.Sleep(80); }
    }
    public static void Type(string text, string window) {
        foreach (char character in text) { Foreground(window); Send(new Input[] { Key(character, false, true), Key(character, true, true) }); }
    }
    public static void Keys(int[] codes, string window) {
        Foreground(window); List<Input> inputs = new List<Input>();
        foreach (int code in codes) inputs.Add(Key((ushort)code, false, false));
        for (int index = codes.Length - 1; index >= 0; index--) inputs.Add(Key((ushort)codes[index], true, false));
        Send(inputs.ToArray());
    }
    public static void Scroll(int delta, string window) {
        Foreground(window); Rect rect;
        if (!GetWindowRect(new IntPtr(long.Parse(window)), out rect)) throw new Exception("无法定位目标窗口");
        int horizontal = (rect.left + rect.right) / 2, vertical = (rect.top + rect.bottom) / 2;
        Rectangle bounds = SystemInformation.VirtualScreen;
        if (!bounds.Contains(horizontal, vertical)) throw new Exception("目标窗口不在屏幕内");
        Protect(WindowFromPoint(new Point { horizontal = horizontal, vertical = vertical }));
        Send(new Input[] { Mouse(0xC001, 0, (int)((long)(horizontal - bounds.Left) * 65535 / Math.Max(1, bounds.Width - 1)), (int)((long)(vertical - bounds.Top) * 65535 / Math.Max(1, bounds.Height - 1))), Mouse(0x0800, unchecked((uint)delta), 0, 0) });
    }
}
'@
try {
    [HarnessDesktop]::Init()
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    [HarnessDesktop]::ForbiddenPid = $request.forbiddenPid
    if ($request.bounds) {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        if ($bounds.X -ne $request.bounds.x -or $bounds.Y -ne $request.bounds.y -or $bounds.Width -ne $request.bounds.width -or $bounds.Height -ne $request.bounds.height) { throw '显示器布局已变化，请重新截图' }
    }
    $result = @{ ok = $true }
    if ($request.action -in @('click', 'type', 'key', 'scroll', 'focus')) {
        [HarnessDesktop]::Protect([IntPtr][long]$request.windowId)
        if ($null -ne $request.targetTitle -and [HarnessDesktop]::Title([IntPtr][long]$request.windowId) -ne $request.targetTitle) { throw '目标窗口标题已变化，请重新截图' }
        [HarnessDesktop]::Focus([long]$request.windowId)
    }
    switch ($request.action) {
        'probe' { $result = @{ available = $true } }
        'windows' { $result = @{ windows = @([HarnessDesktop]::Windows()) } }
        'screenshot' { if ($request.windowId) { [HarnessDesktop]::Focus([long]$request.windowId) }; $result = [HarnessDesktop]::Capture() }
        'focus' { [HarnessDesktop]::Focus([long]$request.windowId) }
        'click' { [HarnessDesktop]::Foreground($request.windowId); [HarnessDesktop]::Click($request.x, $request.y, $request.button, $request.count) }
        'type' { [HarnessDesktop]::Type($request.text, $request.windowId) }
        'key' { [HarnessDesktop]::Keys([int[]]$request.codes, $request.windowId) }
        'scroll' { [HarnessDesktop]::Scroll($request.delta, $request.windowId) }
        default { throw '不支持的桌面操作' }
    }
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
