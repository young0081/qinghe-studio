using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace HarnessSetup {
    public sealed class SetupOptions {
        public string Directory;
        public bool? DesktopShortcut;
        public bool Silent;

        public static SetupOptions Parse(string[] arguments) {
            var options = new SetupOptions();
            for (int index = 0; index < arguments.Length; index++) {
                string argument = arguments[index];
                if (argument == "--directory" && index + 1 < arguments.Length) options.Directory = arguments[++index];
                else if (argument == "--no-desktop-shortcut") options.DesktopShortcut = false;
                else if (argument == "/S") options.Silent = true;
                else if (argument != "/currentuser") throw new ArgumentException("不支持的安装参数：" + argument);
            }
            return options;
        }
    }

    public static class InstallerEngine {
        public const string DirectoryName = "青禾 Studio";
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder result, uint size, string filename);

        public static string Marker(string directory) {
            var value = new StringBuilder(128);
            GetPrivateProfileString("Harness", "AppId", "", value, (uint)value.Capacity, Path.Combine(directory, "harness-install.ini"));
            return value.ToString();
        }

        public static string DefaultDirectory() {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\" + BuildInfo.AppGuid)) {
                var previous = key == null ? null : key.GetValue("InstallLocation") as string;
                if (!String.IsNullOrWhiteSpace(previous)) return previous;
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", DirectoryName);
        }

        public static string DirectoryForSelection(string selected) {
            string directory = Path.GetFullPath(selected);
            if (directory.Length > Path.GetPathRoot(directory).Length) directory = directory.TrimEnd('\\');
            string name = Path.GetFileName(directory);
            if (String.Equals(name, DirectoryName, StringComparison.OrdinalIgnoreCase) || String.Equals(name, "Harness Studio", StringComparison.OrdinalIgnoreCase) || Marker(directory) == BuildInfo.AppGuid)
                return directory;
            return Path.Combine(directory, DirectoryName);
        }

        public static bool DefaultShortcut() {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\" + BuildInfo.AppGuid)) {
                return key == null || Convert.ToString(key.GetValue("HarnessDesktopShortcut")) != "0";
            }
        }

        public static string ValidateDirectory(string candidate) {
            if (String.IsNullOrWhiteSpace(candidate) || candidate.Length < 3 || !Char.IsLetter(candidate[0]) || candidate.Substring(1, 2) != @":\" || candidate.Any(character => Char.IsControl(character) || "\"<>|?*/".Contains(character)))
                throw new IOException(@"请选择完整的本地磁盘路径，例如 D:\Apps\Qinghe Studio。");
            if (candidate.Substring(2).Contains(':') || candidate.Split('\\').Skip(1).Any(segment => segment.EndsWith(".") || segment.EndsWith(" ")))
                throw new IOException("安装路径不能含有冒号或以空格、点结尾的文件夹名。");
            string directory = Path.GetFullPath(candidate).TrimEnd('\\');
            string root = Path.GetPathRoot(directory);
            var protectedFolders = new[] {
                root, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
            };
            if (protectedFolders.Any(folder => String.Equals(folder.TrimEnd('\\'), directory, StringComparison.OrdinalIgnoreCase)))
                throw new IOException("不能安装到系统目录或个人文件夹根目录，请使用独立子文件夹。");
            if (directory.Length > 200) throw new IOException("安装路径太长，请选择较短的专用文件夹。");
            for (var ancestor = new DirectoryInfo(directory); ancestor != null; ancestor = ancestor.Parent) {
                if ((ancestor.Exists || File.Exists(ancestor.FullName)) && (File.GetAttributes(ancestor.FullName) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("安装目录不能经过符号链接或目录联接，请选择普通本地文件夹。");
            }
            if (File.Exists(directory)) throw new IOException("这个位置是文件，请选择专用文件夹。");
            if (System.IO.Directory.Exists(directory) && System.IO.Directory.EnumerateFileSystemEntries(directory).Any() && Marker(directory) != BuildInfo.AppGuid)
                throw new IOException("该目录已有其他文件。请选择空文件夹，避免覆盖项目或便携版。");
            var drive = new DriveInfo(root);
            if (drive.DriveType == DriveType.Network || !drive.IsReady) throw new IOException("请选择可用的本地磁盘。");
            if (drive.AvailableFreeSpace < BuildInfo.PayloadBytes + 33554432L) throw new IOException("安装磁盘可用空间不足，请清理空间或选择其他位置。");
            return directory;
        }

        public static int Run(string candidate, bool desktopShortcut, Action<string> status) {
            string directory = ValidateDirectory(candidate);
            using (var gate = new Mutex(false, @"Local\HarnessStudioSetup-" + BuildInfo.AppGuid)) {
                bool acquired;
                try { acquired = gate.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new IOException("另一个安装任务正在进行，请等待它完成后重试。");
                string temporary = Path.Combine(Path.GetTempPath(), "harness-setup-" + Guid.NewGuid().ToString("N"));
                string engine = Path.Combine(temporary, "engine.exe");
                try {
                    status("正在准备并校验离线安装包…");
                    System.IO.Directory.CreateDirectory(temporary);
                    using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Harness.Engine")) {
                        if (source == null) throw new IOException("安装包缺少安装引擎，请重新下载完整安装器。");
                        using (var output = new FileStream(engine, FileMode.CreateNew, FileAccess.Write, FileShare.None)) source.CopyTo(output);
                    }
                    using (var locked = new FileStream(engine, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                        using (var hash = SHA256.Create()) {
                            string digest = BitConverter.ToString(hash.ComputeHash(locked)).Replace("-", "").ToLowerInvariant();
                            if (digest != BuildInfo.EngineHash) throw new IOException("安装包完整性校验失败，请重新下载安装器。");
                        }
                        ValidateDirectory(directory);
                        status("正在安装程序与快捷方式…");
                        var start = new ProcessStartInfo(engine) {
                            Arguments = "/S /currentuser" + (desktopShortcut ? " --desktop-shortcut" : " --no-desktop-shortcut") + " /D=" + directory,
                            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = temporary
                        };
                        using (var backend = Process.Start(start)) {
                            backend.WaitForExit();
                            if (backend.ExitCode != 0) return backend.ExitCode;
                        }
                    }
                    status("正在确认安装结果…");
                    if (Marker(directory) != BuildInfo.AppGuid || !File.Exists(Path.Combine(directory, "Harness Studio.exe")) || !File.Exists(Path.Combine(directory, "resources", "app.asar")))
                        throw new IOException("安装引擎已退出，但未找到完整程序。请检查磁盘空间与文件权限后重试。");
                    return 0;
                } finally {
                    try { if (File.Exists(engine)) File.Delete(engine); if (System.IO.Directory.Exists(temporary)) System.IO.Directory.Delete(temporary); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    gate.ReleaseMutex();
                }
            }
        }

        public static string Failure(int code) {
            if (code == 3) return "请先保存任务并关闭此安装位置的 青禾 Studio，再重试。没有强制结束任何应用。";
            if (code == 2) return "安装未完成：请检查目录权限、可用空间及 PowerShell 是否可用；若已安装，请先关闭桌面版再重试。（代码 2）";
            return "安装引擎未能完成任务（代码 " + code + "）。请检查目录权限、磁盘空间及是否有其他安装任务，再重试。";
        }
    }

    public sealed class SetupWindow {
        readonly Window window;
        readonly Button primary;
        readonly Button back;
        readonly Button close;
        readonly TextBox installPath;
        readonly CheckBox desktopShortcut;
        readonly FrameworkElement[] pages;
        int pageIndex;
        int exitCode;
        bool busy;

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);

        public SetupWindow(SetupOptions options) {
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Harness.Setup.xaml")) window = (Window)XamlReader.Load(source);
            primary = Find<Button>("PrimaryAction");
            back = Find<Button>("Back");
            close = Find<Button>("Close");
            installPath = Find<TextBox>("InstallPath");
            desktopShortcut = Find<CheckBox>("DesktopShortcut");
            pages = new[] { Find<FrameworkElement>("WelcomePage"), Find<FrameworkElement>("OptionsPage"), Find<FrameworkElement>("ProgressPage"), Find<FrameworkElement>("FinishedPage") };
            installPath.Text = options.Directory ?? InstallerEngine.DefaultDirectory();
            desktopShortcut.IsChecked = options.DesktopShortcut ?? InstallerEngine.DefaultShortcut();
            Find<TextBlock>("VersionLabel").Text = "SETUP / " + BuildInfo.Version;
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Harness.Scene")) {
                var bitmap = new BitmapImage();
                bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = source; bitmap.EndInit(); bitmap.Freeze();
                Find<Image>("Scene").Source = bitmap;
            }
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Harness.Icon")) window.Icon = BitmapFrame.Create(source, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            primary.Click += async (sender, eventArgs) => {
                if (pageIndex == 0) ShowPage(1);
                else if (pageIndex == 1) await Install();
                else if (pageIndex == 3) Finish();
            };
            back.Click += (sender, eventArgs) => ShowPage(0);
            close.Click += (sender, eventArgs) => window.Close();
            Find<Button>("Minimize").Click += (sender, eventArgs) => window.WindowState = WindowState.Minimized;
            Find<Button>("Browse").Click += (sender, eventArgs) => {
                try {
                    string selected = FolderPicker.Select(new WindowInteropHelper(window).Handle);
                    if (selected != null) installPath.Text = InstallerEngine.DirectoryForSelection(selected);
                } catch (Exception failure) { ShowError("无法打开文件夹选择器，可直接输入安装位置。" + failure.Message); }
            };
            Find<Grid>("TitleBar").MouseLeftButtonDown += (sender, eventArgs) => {
                if (eventArgs.OriginalSource == sender && eventArgs.ButtonState == MouseButtonState.Pressed) window.DragMove();
            };
            window.PreviewKeyDown += (sender, eventArgs) => { if (eventArgs.Key == Key.Escape) { window.Close(); eventArgs.Handled = true; } };
            window.Closing += OnClosing;
            window.Closed += (sender, eventArgs) => Application.Current.Shutdown(exitCode);
            window.SourceInitialized += (sender, eventArgs) => {
                int noRounding = 1;
                int noBorder = -2;
                var handle = new WindowInteropHelper(window).Handle;
                DwmSetWindowAttribute(handle, 33, ref noRounding, 4);
                DwmSetWindowAttribute(handle, 34, ref noBorder, 4);
            };
            window.Loaded += (sender, eventArgs) => { Animate(pages[0]); primary.Focus(); };
            var area = SystemParameters.WorkArea;
            double scale = Math.Min(1, Math.Min((area.Width - 24) / window.Width, (area.Height - 24) / window.Height));
            if (scale < 1) {
                var content = (FrameworkElement)window.Content;
                window.Content = null;
                content.Width = window.Width; content.Height = window.Height;
                window.Content = new Viewbox { Child = content };
                window.Width *= scale; window.Height *= scale;
            }
        }

        TElement Find<TElement>(string name) where TElement : FrameworkElement { return (TElement)window.FindName(name); }
        public Window Window { get { return window; } }

        void ShowError(string message) {
            Find<TextBlock>("ErrorText").Text = message;
            Find<FrameworkElement>("ErrorPanel").Visibility = Visibility.Visible;
        }

        void OnClosing(object sender, CancelEventArgs eventArgs) {
            if (busy) {
                eventArgs.Cancel = true;
                Find<TextBlock>("ProgressDetail").Text = "安装正在写入程序，请等待完成后关闭。可以先最小化窗口。";
            }
        }

        void Animate(FrameworkElement element) {
            if (!SystemParameters.ClientAreaAnimation) return;
            element.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)));
            var translate = new TranslateTransform();
            element.RenderTransform = translate;
            translate.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(10, 0, TimeSpan.FromMilliseconds(220)) { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } });
        }

        void ShowPage(int index) {
            pageIndex = index;
            Find<FrameworkElement>("ErrorPanel").Visibility = Visibility.Collapsed;
            for (int current = 0; current < pages.Length; current++) pages[current].Visibility = current == index ? Visibility.Visible : Visibility.Collapsed;
            back.Visibility = index == 1 ? Visibility.Visible : Visibility.Collapsed;
            Find<FrameworkElement>("FooterNote").Visibility = index == 1 ? Visibility.Collapsed : Visibility.Visible;
            primary.Content = new[] { "开始设置  →", "安装到这里  →", "正在安装…", "完成  ✓" }[index];
            primary.IsEnabled = index != 2;
            close.IsEnabled = index != 2;
            foreach (FrameworkElement pixel in Find<StackPanel>("LoadingPixels").Children) {
                pixel.BeginAnimation(UIElement.OpacityProperty, null);
                if (index == 2 && SystemParameters.ClientAreaAnimation) {
                    pixel.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0.25, 1, TimeSpan.FromMilliseconds(500)) {
                        AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever,
                        BeginTime = TimeSpan.FromMilliseconds(Find<StackPanel>("LoadingPixels").Children.IndexOf(pixel) * 150)
                    });
                }
            }
            Animate(pages[index]);
            if (index != 2) primary.Focus();
        }

        async Task Install() {
            string directory;
            try { directory = InstallerEngine.ValidateDirectory(installPath.Text); }
            catch (Exception failure) { ShowError(failure.Message); installPath.Focus(); return; }
            installPath.Text = directory;
            bool shortcut = desktopShortcut.IsChecked == true;
            busy = true;
            ShowPage(2);
            try {
                exitCode = await Task.Run(() => InstallerEngine.Run(directory, shortcut, status => window.Dispatcher.Invoke(() => Find<TextBlock>("ProgressStatus").Text = status)));
                if (exitCode != 0) throw new IOException(InstallerEngine.Failure(exitCode));
                Find<TextBlock>("InstalledPath").Text = "已安装到 " + directory;
                ShowPage(3);
            } catch (Exception failure) {
                if (exitCode == 0) exitCode = 2;
                ShowPage(1);
                ShowError(failure.Message);
            } finally { busy = false; }
        }

        void Finish() {
            try {
                if (Find<CheckBox>("LaunchAfter").IsChecked == true) Process.Start(new ProcessStartInfo(Path.Combine(installPath.Text, "Harness Studio.exe")) { UseShellExecute = true, WorkingDirectory = installPath.Text });
                window.Close();
            } catch (Exception failure) { ShowError("程序已安装，但启动失败。可以从开始菜单打开。" + failure.Message); }
        }
    }

    public static class Program {
        [STAThread]
        public static int Main(string[] arguments) {
            try {
                var options = SetupOptions.Parse(arguments);
                if (options.Silent) return InstallerEngine.Run(options.Directory ?? InstallerEngine.DefaultDirectory(), options.DesktopShortcut ?? InstallerEngine.DefaultShortcut(), status => { });
                var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                return application.Run(new SetupWindow(options).Window);
            } catch (Exception failure) {
                if (!arguments.Contains("/S")) MessageBox.Show(failure.Message, "青禾 Studio 安装器", MessageBoxButton.OK, MessageBoxImage.Warning);
                return 2;
            }
        }
    }
}
