using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class InstallerWindow {
    public delegate bool WindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder value, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder value, int maximum);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int identifier);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr first, IntPtr second);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr first, string second);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out RectangleData rectangle);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr context, uint flags);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr handle, IntPtr rectangle, IntPtr region, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int state);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int WindowStyle(IntPtr handle, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] struct RectangleData { public int Left, Top, Right, Bottom; }
    public class Control {
        public IntPtr Handle;
        public int Id;
        public string Text;
        public string ClassName;
        public bool Visible;
        public bool Enabled;
        public int Width;
        public int Height;
        public int Left;
        public int Top;
    }
    static Control Describe(IntPtr handle) {
        var text = new StringBuilder(4096);
        var name = new StringBuilder(256);
        GetWindowText(handle, text, text.Capacity);
        GetClassName(handle, name, name.Capacity);
        RectangleData bounds;
        GetWindowRect(handle, out bounds);
        return new Control { Handle = handle, Id = GetDlgCtrlID(handle), Text = text.ToString(), ClassName = name.ToString(), Visible = IsWindowVisible(handle), Enabled = IsWindowEnabled(handle), Width = bounds.Right - bounds.Left, Height = bounds.Bottom - bounds.Top, Left = bounds.Left, Top = bounds.Top };
    }
    public static Control[] Windows(int[] processes) {
        var results = new List<Control>();
        EnumWindows((handle, parameter) => {
            uint process;
            GetWindowThreadProcessId(handle, out process);
            if (Array.IndexOf(processes, (int)process) >= 0) results.Add(Describe(handle));
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }
    public static Control[] Children(IntPtr parent) {
        var results = new List<Control>();
        EnumChildWindows(parent, (handle, parameter) => { results.Add(Describe(handle)); return true; }, IntPtr.Zero);
        return results.ToArray();
    }
    public static void Capture(IntPtr handle, string filename) {
        var previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(handle));
        try {
        RedrawWindow(handle, IntPtr.Zero, IntPtr.Zero, 0x185);
        RectangleData bounds;
        if (!GetWindowRect(handle, out bounds)) throw new Exception("Installer window not available");
        using (var bitmap = new Bitmap(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                var context = graphics.GetHdc();
                try { if (!PrintWindow(handle, context, 2)) throw new Exception("Installer window capture failed"); }
                finally { graphics.ReleaseHdc(context); }
            }
            bitmap.Save(filename, ImageFormat.Png);
        }
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
