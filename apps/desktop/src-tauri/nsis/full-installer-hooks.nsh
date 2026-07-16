; Internal full installer hooks for MetOrigin Splat.
; These hooks only touch files below $INSTDIR. User projects, PLY files and
; checkpoints are intentionally outside the installer/uninstaller lifecycle.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro METORIGIN_REQUIRE_STOPPED_PROCESSES
  ; Windows 10/11 always includes Windows PowerShell 5.1. Use process names
  ; rather than paths so upgrades also catch an older installation directory.
  nsExec::ExecToStack /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (@(Get-Process -Name $\'MetOrigin Splat$\',$\'splat-desktop$\',$\'ffmpeg$\',$\'ffprobe$\',$\'colmap$\',$\'brush_app$\' -ErrorAction SilentlyContinue).Count -gt 0) { exit 20 }"'
  Pop $R8
  Pop $R9
  ${If} $R8 == 20
    MessageBox MB_OK|MB_ICONSTOP "MetOrigin Splat or a bundled engine is still running.$\r$\nClose MetOrigin Splat, FFmpeg, FFprobe, COLMAP and Brush, then try again.$\r$\n$\r$\nMetOrigin Splat 或内置引擎仍在运行。请先关闭应用和 FFmpeg、FFprobe、COLMAP、Brush，然后重试。"
    Abort
  ${ElseIf} $R8 != 0
    MessageBox MB_OK|MB_ICONSTOP "Unable to verify running MetOrigin processes (code $R8). Installation cannot continue safely.$\r$\n$\r$\n无法检查 MetOrigin 相关进程（代码 $R8），安装无法安全继续。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Require at least 2 GiB free on the Windows system drive before an install
  ; or upgrade starts. /D=F selects free space and /S=M reports MiB.
  ${DriveSpace} "$WINDIR" "/D=F /S=M" $R8
  ${If} $R8 < 2048
    MessageBox MB_OK|MB_ICONSTOP "At least 2 GiB of free space is required on the Windows system drive.$\r$\n$\r$\nWindows 系统盘至少需要 2 GiB 可用空间。"
    Abort
  ${EndIf}
  !insertmacro METORIGIN_REQUIRE_STOPPED_PROCESSES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The locked VC++ Runtime is copied as a Tauri resource, executed silently,
  ; then removed. 0=installed, 1638=another/newer version, 3010=reboot needed.
  ${IfNot} ${FileExists} "$INSTDIR\resources\installer\vc_redist.x64.exe"
    MessageBox MB_OK|MB_ICONSTOP "The bundled Microsoft Visual C++ Runtime is missing. Rebuild or repair the installer.$\r$\n$\r$\n内置 Microsoft Visual C++ 运行库缺失，请重新构建或修复安装程序。"
    Abort
  ${EndIf}

  nsExec::ExecToStack /TIMEOUT=600000 '"$INSTDIR\resources\installer\vc_redist.x64.exe" /install /quiet /norestart'
  Pop $R8
  Pop $R9
  Delete "$INSTDIR\resources\installer\vc_redist.x64.exe"
  RMDir "$INSTDIR\resources\installer"

  ${If} $R8 == 0
    DetailPrint "Microsoft Visual C++ Runtime installed."
  ${ElseIf} $R8 == 1638
    DetailPrint "Microsoft Visual C++ Runtime is already installed."
  ${ElseIf} $R8 == 3010
    DetailPrint "Microsoft Visual C++ Runtime installed; restart required."
    SetRebootFlag true
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ Runtime installation failed with code $R8.$\r$\n$\r$\nMicrosoft Visual C++ 运行库安装失败，退出代码：$R8。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro METORIGIN_REQUIRE_STOPPED_PROCESSES
!macroend
