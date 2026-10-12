using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using HarnessSetup;
using Microsoft.Win32;

public static class InstallerValidationTests {
    static void Assert(bool condition, string message) {
        if (!condition) throw new Exception(message);
    }

    static void Reject(string path) {
        bool refused = false;
        try { InstallerEngine.ValidateDirectory(path); }
        catch (IOException) { refused = true; }
        catch (ArgumentException) { refused = true; }
        Assert(refused, "Unsafe directory accepted: " + path);
    }

    [STAThread]
    public static int Main(string[] arguments) {
        string temporary = arguments[0];
        Assert(BuildInfo.AppGuid.StartsWith("qinghe-installer-unit-"), "Registry test must use an isolated identity");
        string registryPath = @"Software\" + BuildInfo.AppGuid;
        using (var existing = Registry.CurrentUser.OpenSubKey(registryPath)) Assert(existing == null, "Test registry key already exists");
        Assert(InstallerEngine.DefaultDirectory() == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "青禾 Studio"), "Fresh installation kept the old folder name");
        try {
            foreach (string previous in new[] { Path.Combine(temporary, "Harness Studio"), Path.Combine(temporary, "custom-location"), Path.Combine(temporary, "青禾 Studio") }) {
                using (var key = Registry.CurrentUser.CreateSubKey(registryPath)) key.SetValue("InstallLocation", previous);
                Assert(InstallerEngine.DefaultDirectory() == previous, "Upgrade changed the saved install location");
            }
        } finally { Registry.CurrentUser.DeleteSubKeyTree(registryPath, false); }
        Assert(InstallerEngine.DirectoryForSelection(temporary) == Path.Combine(temporary, "青禾 Studio"), "Folder picker appended old brand");
        string branded = Path.Combine(temporary, "青禾 Studio");
        Assert(InstallerEngine.DirectoryForSelection(branded + "\\") == branded, "Folder picker nested the current brand");
        string legacy = Path.Combine(temporary, "Harness Studio");
        Assert(InstallerEngine.DirectoryForSelection(legacy) == legacy, "Folder picker nested the legacy installation");
        string diskRoot = Path.GetPathRoot(temporary);
        Assert(InstallerEngine.DirectoryForSelection(diskRoot) == Path.Combine(diskRoot, "青禾 Studio"), "Folder picker changed a drive root into a relative path");
        var options = SetupOptions.Parse(new[] { "--directory", @"C:\Apps\中文 & (Harness)", "--no-desktop-shortcut", "/S" });
        Assert(options.Directory == @"C:\Apps\中文 & (Harness)" && options.DesktopShortcut == false && options.Silent, "Command-line options lost path or flags");
        bool refusedOption = false;
        try { SetupOptions.Parse(new[] { "--directory" }); }
        catch (ArgumentException) { refusedOption = true; }
        Assert(refusedOption, "Missing directory value accepted");
        foreach (string invalid in new[] { "", "relative", @"\\server\share\app", @"C:\Apps\bad\""name", @"C:\Apps\trailing.\App", "C:\\Apps\\line\nname", @"C:\Apps\stream:name", Path.GetPathRoot(temporary), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) }) Reject(invalid);
        string empty = Path.Combine(temporary, "中文 & (Harness) 空目录");
        Directory.CreateDirectory(empty);
        Assert(InstallerEngine.ValidateDirectory(empty) == empty, "Safe Unicode path was changed");
        File.WriteAllText(Path.Combine(empty, "user-project.txt"), "preserve");
        Reject(empty);
        File.WriteAllText(Path.Combine(empty, "harness-install.ini"), "[Harness]\r\nAppId=another-app\r\n");
        Reject(empty);
        File.WriteAllText(Path.Combine(empty, "harness-install.ini"), "[Harness]\r\nAppId=" + BuildInfo.AppGuid + "\r\n");
        Assert(InstallerEngine.ValidateDirectory(empty) == empty, "Existing matching installation rejected");
        Assert(InstallerEngine.DirectoryForSelection(empty) == empty, "Folder picker nested a custom installation");
        Reject(Path.Combine(empty, "user-project.txt"));
        using (var source = File.OpenRead(arguments[1])) {
            var window = (Window)XamlReader.Load(source);
            Assert(window.WindowStyle == WindowStyle.None && window.ResizeMode == ResizeMode.NoResize, "Native window chrome was restored");
            foreach (string name in new[] { "PrimaryAction", "Back", "Close", "Browse", "Minimize" }) Assert(((Button)window.FindName(name)).Template != null, "Missing self-drawn button: " + name);
            Assert(((CheckBox)window.FindName("DesktopShortcut")).Template != null, "Missing self-drawn checkbox");
            Assert(((CheckBox)window.FindName("LaunchAfter")).IsChecked == false, "Unexpected automatic application launch");
        }
        Console.WriteLine("Installer validation passed: options, protected paths, Unicode, marker ownership, self-drawn XAML.");
        return 0;
    }
}
