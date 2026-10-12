!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include WinMessages.nsh
!include MUI2.nsh

!define QINGHE_INSTALL_DIRECTORY "青禾 Studio"

!define MUI_BGCOLOR "FFFEF5"
!define MUI_TEXTCOLOR "415334"
!define MUI_INSTFILESPAGE_COLORS "58733B F0F5E8"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "退出安装？尚未安装时不会更改程序或工作区。"
!define MUI_UNABORTWARNING
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.HarnessThemeInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT HarnessThemeInit
!endif
!define MUI_INSTFILESPAGE_HEADER_TEXT "正在搭建你的工作台"
!define MUI_INSTFILESPAGE_HEADER_SUBTEXT "正在复制本地程序文件。进度来自实际安装，不需要下载模型。"
!define MUI_UNINSTFILESPAGE_HEADER_TEXT "正在移除程序文件"
!define MUI_UNINSTFILESPAGE_HEADER_SUBTEXT "工作区、会话、附件和桌面偏好不会主动删除。"
!define MUI_UNFINISHPAGE_TITLE "程序已卸载，作品仍在"
!define MUI_UNFINISHPAGE_TEXT "青禾 Studio 程序文件已移除。$\r$\n$\r$\n项目、会话、模型配置和附件仍保留在各工作区，桌面偏好仍保留在用户数据目录。"

!ifndef BUILD_UNINSTALLER
Var HarnessDialog
Var HarnessControl
Var HarnessImage
Var HarnessBitmap
Var HarnessPath
Var HarnessDesktop
Var HarnessDesktopCheck
Var HarnessLaunch
Var HarnessProblem
Var HarnessMarker
!endif
Var HarnessFont
Var HarnessTitleFont
Var HarnessCandidate
Var HarnessMouseDown
Var HarnessCloseLeft

!macro HarnessLabel LEFT TOP WIDTH HEIGHT TEXT COLOR
  ${NSD_CreateLabel} ${LEFT} ${TOP} ${WIDTH} ${HEIGHT} "${TEXT}"
  Pop $HarnessControl
  SetCtlColors $HarnessControl "${COLOR}" "FFFEF5"
  SendMessage $HarnessControl ${WM_SETFONT} $HarnessFont 1
!macroend

!macro HarnessTheme PREFIX
Function ${PREFIX}HarnessThemeInit
  CreateFont $HarnessFont "Microsoft YaHei UI" 9
  CreateFont $HarnessTitleFont "Microsoft YaHei UI" 18 700
  SetCtlColors $HWNDPARENT "415334" "FFFEF5"
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "8B9C76" "FFFEF5"
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 "415334" "E4EFD7"
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  System::Call '*(i, i, i, i) p .r0'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i, i, i .r1, i .r2)'
  System::Free $0
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0'
  IntOp $0 $0 & 0xFF3BFF7F
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r0'
  IntOp $0 $0 & 0xFFFDFCFE
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i -2, i 4)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r1, i r2, i 0x26)'
  IntOp $HarnessCloseLeft $1 - 40
  GetDlgItem $0 $HWNDPARENT 1046
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'user32::MoveWindow(p r0, i $HarnessCloseLeft, i 8, i 28, i 24, i 1)'
  SendMessage $0 ${WM_SETTEXT} 0 "STR:×"
  SetCtlColors $0 "587B3B" "EEF4E5"
  StrCpy $HarnessMouseDown 0
FunctionEnd

Function ${PREFIX}HarnessStartChrome
  Call ${PREFIX}HarnessChrome
  ${NSD_CreateTimer} ${PREFIX}HarnessChrome 60
FunctionEnd

Function ${PREFIX}HarnessChrome
  Push $0
  Push $1
  Push $2
  Push $3
  GetDlgItem $0 $HWNDPARENT 2
  ${NSD_GetText} $0 $1
  ${If} $1 != "×"
    SendMessage $0 ${WM_SETTEXT} 0 "STR:×"
  ${EndIf}
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 3)'
  System::Call 'user32::GetAsyncKeyState(i 1) i .r1'
  IntOp $1 $1 & 0x8000
  ${If} $1 == 0
    StrCpy $HarnessMouseDown 0
  ${ElseIf} $HarnessMouseDown == 0
    StrCpy $HarnessMouseDown 1
    System::Call 'user32::GetForegroundWindow() p .r0'
    ${If} $0 == $HWNDPARENT
      System::Call '*(i, i) p .r0'
      System::Call 'user32::GetCursorPos(p r0)'
      System::Call 'user32::ScreenToClient(p $HWNDPARENT, p r0)'
      System::Call '*$0(i .r2, i .r3)'
      System::Free $0
      ${If} $2 >= 0
      ${AndIf} $2 < $HarnessCloseLeft
      ${AndIf} $3 >= 0
      ${AndIf} $3 < 52
        System::Call 'user32::ReleaseCapture()'
        SendMessage $HWNDPARENT 0xA1 2 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!if "${PREFIX}" == ""
Function .onGUIEnd
!else
Function un.onGUIEnd
!endif
  ${NSD_KillTimer} ${PREFIX}HarnessChrome
FunctionEnd

!macroend

!ifndef BUILD_UNINSTALLER
Function HarnessProgressTheme
  Call HarnessStartChrome
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 "415334" "FFFEF5"
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  SendMessage $1 0x409 0 0x79A94B
  SendMessage $1 0x2001 0 0xE8F5F0
FunctionEnd
!insertmacro HarnessTheme ""
!else
!insertmacro HarnessTheme "un."
!endif

!macro HarnessReparseCheck PREFIX
Function ${PREFIX}HarnessCheckReparse
  Pop $HarnessCandidate
  ${DoWhile} $HarnessCandidate != ""
    System::Call 'kernel32::GetFileAttributesW(w "$HarnessCandidate") i .r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "安装目录不能经过符号链接或目录联接，请选择普通本地文件夹。" /SD IDOK
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
    ${GetParent} "$HarnessCandidate" $HarnessCandidate
  ${Loop}
FunctionEnd
!macroend
!ifndef BUILD_UNINSTALLER
!insertmacro HarnessReparseCheck ""
!else
!insertmacro HarnessReparseCheck "un."
!endif

!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariableW(w "HARNESS_SETUP_EXECUTABLE", w "$INSTDIR\${PRODUCT_FILENAME}.exe")'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference = $\'Stop$\'; try { if (@(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -eq $$env:HARNESS_SETUP_EXECUTABLE }).Count) { exit 3 }; exit 0 } catch { exit 2 }"'
  Pop $0
  Pop $1
  ${If} $0 == 3
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存任务并关闭 青禾 Studio，再重试安装或卸载。安装器不会强制结束应用。" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法检查正在运行的程序。请确认系统 PowerShell 可用后重试；没有强制关闭任何应用。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro customHeader
  Caption "青禾 Studio · 像素安装向导"
  BrandingText "QINGHE / STUDIO     ${VERSION}     LOCAL FIRST"
  !undef APP_INSTALLER_STORE_FILE
  !define APP_INSTALLER_STORE_FILE "${APP_GUID}\installer.exe"
  !ifndef BUILD_UNINSTALLER
    SilentInstall silent
    Section "-Harness directory safety"
      Call HarnessValidateDirectory
    SectionEnd
  !endif
!macroend

!macro customInit
  ${If} ${isForAllUsers}
    MessageBox MB_OK|MB_ICONSTOP "此安装程序仅支持当前用户安装，不需要管理员权限。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro setInstallModePerUser
  !insertmacro GetDParameter $0
  ${If} $0 == ""
  ${AndIf} $perUserInstallationFolder == ""
    ${GetParent} "$INSTDIR" $0
    StrCpy $INSTDIR "$0\${QINGHE_INSTALL_DIRECTORY}"
  ${EndIf}
  StrCpy $HarnessDesktop ${BST_CHECKED}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "HarnessDesktopShortcut"
  ${If} $0 == "0"
    StrCpy $HarnessDesktop ${BST_UNCHECKED}
  ${EndIf}
  ${If} ${isNoDesktopShortcut}
    StrCpy $HarnessDesktop ${BST_UNCHECKED}
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--desktop-shortcut" $1
  ${IfNot} ${Errors}
    StrCpy $HarnessDesktop ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customUnInstallCheck
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $R0 != 0
    SetErrorLevel $R0
    Quit
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customWelcomePage
  Page custom HarnessWelcome
!macroend

Function HarnessWelcome
  !insertmacro MUI_HEADER_TEXT "青禾 Studio" "01  欢迎    /    02  安装设置    /    03  开始构建"
  nsDialogs::Create 1018
  Pop $HarnessDialog
  SetCtlColors $HarnessDialog "415334" "FFFEF5"
  InitPluginsDir
  File /oname=$PLUGINSDIR\scene.bmp "${PROJECT_DIR}\desktop\installer\generated\scene.bmp"
  ${NSD_CreateBitmap} 0u 0u 104u 140u ""
  Pop $HarnessImage
  ${NSD_SetStretchedImage} $HarnessImage "$PLUGINSDIR\scene.bmp" $HarnessBitmap
  !insertmacro HarnessLabel 116u 1u 180u 13u "A LITTLE IDEA. A WHOLE NEW WORLD." "8BA268"
  !insertmacro HarnessLabel 116u 21u 180u 49u "把想法，$\r$\n搭成你的工作台。" "587B3B"
  SendMessage $HarnessControl ${WM_SETFONT} $HarnessTitleFont 1
  !insertmacro HarnessLabel 116u 78u 180u 26u "原生模型 · 编程工具 · 本地会话$\r$\nBrowser / Computer · 文档与多媒体" "667957"
  !insertmacro HarnessLabel 116u 114u 180u 25u "Windows x64  /  v${VERSION}$\r$\n离线安装，无需另装 Node.js。" "8B9275"
  Call HarnessStartChrome
  nsDialogs::Show
  ${NSD_FreeImage} $HarnessBitmap
FunctionEnd

!macro customPageAfterChangeDir
  Page custom HarnessOptions HarnessOptionsLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW HarnessProgressTheme
!macroend

Function HarnessOptions
  !insertmacro MUI_HEADER_TEXT "给工作台安个家" "选择一个专用程序文件夹。项目数据与安装位置分开保存。"
  nsDialogs::Create 1018
  Pop $HarnessDialog
  SetCtlColors $HarnessDialog "415334" "FFFEF5"
  !insertmacro HarnessLabel 0u 0u 295u 13u "02 / INSTALL LOCATION" "8BA268"
  !insertmacro HarnessLabel 0u 20u 295u 13u "安装目录（新建空文件夹，或已有安装位置）" "587B3B"
  ${NSD_CreateDirRequest} 0u 38u 246u 16u "$INSTDIR"
  Pop $HarnessPath
  SetCtlColors $HarnessPath "415334" "F0F5E8"
  ${NSD_CreateBrowseButton} 251u 38u 45u 16u "浏览…"
  Pop $HarnessControl
  ${NSD_OnClick} $HarnessControl HarnessBrowse
  ${NSD_CreateCheckbox} 0u 67u 285u 14u "创建桌面快捷方式"
  Pop $HarnessDesktopCheck
  ${NSD_SetState} $HarnessDesktopCheck $HarnessDesktop
  SetCtlColors $HarnessDesktopCheck "587B3B" "FFFEF5"
  !insertmacro HarnessLabel 0u 90u 296u 23u "开始菜单入口与系统卸载入口会自动添加。$\r$\n仅为当前用户安装，不修改模型配置或工作区。" "667957"
  !insertmacro HarnessLabel 0u 121u 296u 20u "请勿把项目存进程序文件夹。升级前请先退出桌面版。" "9A8558"
  Call HarnessStartChrome
  nsDialogs::Show
FunctionEnd

Function HarnessBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置的父文件夹" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
    ${GetFileName} "$0" $1
    ReadINIStr $2 "$0\harness-install.ini" "Harness" "AppId"
    ${If} $1 != "${QINGHE_INSTALL_DIRECTORY}"
    ${AndIf} $1 != "Harness Studio"
    ${AndIf} $2 != "${APP_GUID}"
      StrCpy $0 "$0\${QINGHE_INSTALL_DIRECTORY}"
    ${EndIf}
    ${NSD_SetText} $HarnessPath "$0"
  ${EndIf}
FunctionEnd

Function HarnessOptionsLeave
  ${NSD_GetText} $HarnessPath $INSTDIR
  ${NSD_GetState} $HarnessDesktopCheck $HarnessDesktop
  Call HarnessValidateDirectory
FunctionEnd

Function HarnessValidateDirectory
  SetErrorLevel 0
  StrCpy $HarnessProblem ""
  StrCpy $0 $INSTDIR 2 1
  ${If} $0 != ":\"
    StrCpy $HarnessProblem "请选择完整的本地磁盘路径，例如 D:\Apps\Qinghe Studio。"
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$DESKTOP"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$APPDATA"
    StrCpy $HarnessProblem "不能安装到系统目录或个人文件夹根目录，请使用独立子文件夹。"
  ${EndIf}
  Push "$INSTDIR"
  Call HarnessCheckReparse
  ReadINIStr $HarnessMarker "$INSTDIR\harness-install.ini" "Harness" "AppId"
  ${If} $HarnessMarker != "${APP_GUID}"
    FindFirst $0 $1 "$INSTDIR\*.*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        StrCpy $HarnessProblem "该目录已有其他文件。请选择空文件夹，避免覆盖项目或便携版。"
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
  ${EndIf}
  ${If} $HarnessProblem != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$HarnessProblem" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

!macro customInstall
  WriteINIStr "$INSTDIR\harness-install.ini" "Harness" "AppId" "${APP_GUID}"
  WriteINIStr "$INSTDIR\harness-install.ini" "Harness" "Version" "${VERSION}"
  ${If} $HarnessDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "HarnessDesktopShortcut" "1"
  ${Else}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "HarnessDesktopShortcut"
    ${If} $0 == "1"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${EndIf}
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "HarnessDesktopShortcut" "0"
  ${EndIf}
!macroend

!macro customFinishPage
  Page custom HarnessFinish HarnessFinishLeave
!macroend

Function HarnessFinish
  !insertmacro MUI_HEADER_TEXT "工作台已准备好" "03 / READY TO BUILD"
  nsDialogs::Create 1018
  Pop $HarnessDialog
  SetCtlColors $HarnessDialog "415334" "FFFEF5"
  !insertmacro HarnessLabel 0u 5u 296u 30u "安装完成，开始创造。" "587B3B"
  SendMessage $HarnessControl ${WM_SETFONT} $HarnessTitleFont 1
  !insertmacro HarnessLabel 0u 47u 296u 28u "打开 青禾 Studio 后，选择你的项目工作区，$\r$\n在「供应商与模型」中接入真实模型，即可开始。" "667957"
  ${NSD_CreateCheckbox} 0u 88u 296u 15u "完成后打开 青禾 Studio"
  Pop $HarnessLaunch
  SetCtlColors $HarnessLaunch "587B3B" "FFFEF5"
  !insertmacro HarnessLabel 0u 118u 296u 22u "可从开始菜单启动；系统「已安装的应用」中可卸载。" "8B9275"
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  Call HarnessStartChrome
  nsDialogs::Show
FunctionEnd

Function HarnessFinishLeave
  ${NSD_GetState} $HarnessLaunch $0
  ${If} $0 == ${BST_CHECKED}
    ExecShell "open" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  ${EndIf}
FunctionEnd
!endif

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.HarnessStartChrome
  !define MUI_WELCOMEPAGE_TITLE "卸载程序，保留作品。"
  !define MUI_WELCOMEPAGE_TEXT "这将移除 青禾 Studio 的程序文件和快捷方式。$\r$\n$\r$\n项目工作区、会话、附件、模型配置和桌面偏好不会主动删除。$\r$\n$\r$\n请先保存任务并关闭桌面版。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.HarnessStartChrome
!macroend

!macro customUnInit
  Push "$INSTDIR"
  Call un.HarnessCheckReparse
  ReadINIStr $0 "$INSTDIR\harness-install.ini" "Harness" "AppId"
  ${If} $0 != "${APP_GUID}"
    MessageBox MB_OK|MB_ICONSTOP "安装标记不匹配，拒绝删除此目录。请从原安装目录运行卸载程序。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "HarnessDesktopShortcut"
  ${If} $0 == "1"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${EndIf}
  Delete "$LOCALAPPDATA\${APP_GUID}\installer.exe"
  RMDir "$LOCALAPPDATA\${APP_GUID}"
!macroend

!include "${PROJECT_DIR}\desktop\installer\generated\remove-files.nsh"
!macro customRemoveFiles
  !insertmacro HarnessRemovePayload
  Delete "$INSTDIR\harness-install.ini"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend
