; Internal alignment candidate hooks. The legacy full-installer hook is frozen.
; Files are limited to $INSTDIR and shortcuts proven to target this installation.
; User projects, PLY files and checkpoints stay outside the installer lifecycle.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro METORIGIN_CLEAR_PROCESS_GUARD_ENV
  System::Call 'kernel32::SetEnvironmentVariableW(w "METORIGIN_CANDIDATE_INSTALL_DIR", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "METORIGIN_CANDIDATE_CALLER_PID", p 0)'
!macroend

!macro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
  Pop $R9
  Pop $R8
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro METORIGIN_REQUIRE_STOPPED_PROCESSES
  ; Pass the selected install path as process-local data, never PowerShell code.
  ; A fresh candidate can coexist with an application/engine in another folder.
  Push $0
  Push $1
  Push $2
  Push $R8
  Push $R9
  ; Maintenance invokes the uninstaller in place with _?=$INSTDIR. Exclude only
  ; this exact NSIS process, never every process with an installer-like name.
  System::Call 'kernel32::GetCurrentProcessId() i.r2'
  StrCpy $0 "$INSTDIR"
  System::Call 'kernel32::SetEnvironmentVariableW(w "METORIGIN_CANDIDATE_INSTALL_DIR", w r0) i.r1'
  ${If} $1 == 0
    !insertmacro METORIGIN_CLEAR_PROCESS_GUARD_ENV
    MessageBox MB_OK|MB_ICONSTOP "Unable to prepare the candidate process check." /SD IDOK
    !insertmacro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
    SetErrorLevel 1
    Abort
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "METORIGIN_CANDIDATE_CALLER_PID", w r2) i.r1'
  ${If} $1 == 0
    !insertmacro METORIGIN_CLEAR_PROCESS_GUARD_ENV
    MessageBox MB_OK|MB_ICONSTOP "Unable to prepare the candidate process check." /SD IDOK
    !insertmacro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
    SetErrorLevel 1
    Abort
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$root=[IO.Path]::GetFullPath($$env:METORIGIN_CANDIDATE_INSTALL_DIR).TrimEnd([char]92)+[IO.Path]::DirectorySeparatorChar; $$callerPid=[UInt32]::Parse($$env:METORIGIN_CANDIDATE_CALLER_PID); if ($$callerPid -eq 0) { exit 21 }; if (@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ProcessId -ne $$callerPid -and $$_.ExecutablePath -and [IO.Path]::GetFullPath($$_.ExecutablePath).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { exit 20 }; exit 0 } catch { exit 21 }"'
  Pop $R8
  Pop $R9
  !insertmacro METORIGIN_CLEAR_PROCESS_GUARD_ENV
  ${If} $R8 == 20
    MessageBox MB_OK|MB_ICONSTOP "The alignment candidate or an engine from this installation is still running. Close this installation, then try again.$\r$\n$\r$\n此安装目录中的候选应用或引擎仍在运行，请先关闭后重试。" /SD IDOK
    !insertmacro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
    SetErrorLevel 1
    Abort
  ${ElseIf} $R8 != 0
    MessageBox MB_OK|MB_ICONSTOP "Unable to verify running MetOrigin processes (code $R8). Installation cannot continue safely.$\r$\n$\r$\n无法检查 MetOrigin 相关进程（代码 $R8），安装无法安全继续。" /SD IDOK
    !insertmacro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
    SetErrorLevel 1
    Abort
  ${EndIf}
  !insertmacro METORIGIN_RESTORE_PROCESS_GUARD_REGISTERS
!macroend

; Tauri's default macro terminates all same-name applications in silent mode.
; Replace it only for this isolated candidate, after utils.nsh defines it.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  !insertmacro METORIGIN_REQUIRE_STOPPED_PROCESSES
!macroend

!macro METORIGIN_IS_OWNED_SHORTCUT shortcut
  !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\MetOrigin Splat Alignment Candidate.exe"
  Pop $R8
  ${If} $R8 != 1
    !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R8
  ${EndIf}
  Push $R8
!macroend

!macro METORIGIN_REQUIRE_OWNED_SHORTCUT shortcut
  ${If} ${FileExists} "${shortcut}"
    !insertmacro METORIGIN_IS_OWNED_SHORTCUT "${shortcut}"
    Pop $R8
    ${If} $R8 != 1
      MessageBox MB_OK|MB_ICONSTOP "Another installation owns a MetOrigin Splat shortcut. Rename that shortcut before retrying; this installer will not overwrite it.$\r$\n$\r$\n另一个安装已占用同名快捷方式。请先重命名该快捷方式后重试，安装程序不会覆盖它。" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro METORIGIN_VALIDATE_SHORTCUT_RENAME legacy renamed
  StrCpy $R9 0
  ${If} ${FileExists} "${legacy}"
    !insertmacro METORIGIN_IS_OWNED_SHORTCUT "${legacy}"
    Pop $R9
  ${EndIf}
  ; Like upstream, /NS and /UPDATE suppress creation, but an existing owned
  ; shortcut can still be maintained. Never overwrite another installation.
  ${If} $NoShortcutMode != 1
  ${AndIf} $UpdateMode != 1
    StrCpy $R9 1
  ${EndIf}
  ${If} $R9 == 1
    !insertmacro METORIGIN_REQUIRE_OWNED_SHORTCUT "${renamed}"
  ${EndIf}
!macroend

!macro METORIGIN_REFRESH_SHORTCUT_ICON shortcut
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READWRITE})'
      ${IShellLink::SetIconLocation} $0 '(w "$INSTDIR\${MAINBINARYNAME}.exe", 0)'
      ${IPersistFile::Save} $1 '("${shortcut}",1)'
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend

!macro METORIGIN_MIGRATE_OWNED_SHORTCUT legacy renamed
  ${If} ${FileExists} "${legacy}"
    !insertmacro METORIGIN_IS_OWNED_SHORTCUT "${legacy}"
    Pop $R8
    ${If} $R8 == 1
      ; Recheck the destination after copying files to cover a shortcut race.
      !insertmacro METORIGIN_REQUIRE_OWNED_SHORTCUT "${renamed}"
      ${If} ${FileExists} "${renamed}"
        !insertmacro SetShortcutTarget "${renamed}" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${Else}
        !insertmacro SetShortcutTarget "${legacy}" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro IsShortcutTarget "${legacy}" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $R8
        ${If} $R8 != 1
          MessageBox MB_OK|MB_ICONSTOP "Unable to update this installation's shortcut. No unrelated shortcut was changed." /SD IDOK
          SetErrorLevel 1
          Abort
        ${EndIf}
        ClearErrors
        Rename "${legacy}" "${renamed}"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONSTOP "Unable to rename this installation's shortcut. Close programs using it, then retry." /SD IDOK
          SetErrorLevel 1
          Abort
        ${EndIf}
      ${EndIf}
      !insertmacro IsShortcutTarget "${renamed}" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $R8
      ${If} $R8 != 1
        MessageBox MB_OK|MB_ICONSTOP "Unable to verify this installation's updated shortcut." /SD IDOK
        SetErrorLevel 1
        Abort
      ${EndIf}
      !insertmacro METORIGIN_REFRESH_SHORTCUT_ICON "${renamed}"
      !insertmacro SetLnkAppUserModelId "${renamed}"
      ; The old name is removed only after the new owned target is verified.
      ${If} ${FileExists} "${legacy}"
        Delete "${legacy}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro METORIGIN_PRESERVE_SHORTCUT_REGISTERS
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
!macroend

!macro METORIGIN_RESTORE_SHORTCUT_REGISTERS
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
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
  ; The official template deletes the recorded old basename in this directory.
  ; Reject unexpected registry data before that deletion can run.
  ReadRegStr $R8 SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $R8 != ""
  ${AndIf} $R8 != "MetOrigin Splat Alignment Candidate.exe"
  ${AndIf} $R8 != "${MAINBINARYNAME}.exe"
    MessageBox MB_OK|MB_ICONSTOP "The saved MetOrigin installation identity is invalid. Installation cannot continue safely." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !insertmacro METORIGIN_PRESERVE_SHORTCUT_REGISTERS
  !insertmacro METORIGIN_VALIDATE_SHORTCUT_RENAME "$DESKTOP\MetOrigin Splat Alignment Candidate.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_VALIDATE_SHORTCUT_RENAME "$SMPROGRAMS\MetOrigin Splat Alignment Candidate.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_VALIDATE_SHORTCUT_RENAME "$SMPROGRAMS\$AppStartMenuFolder\MetOrigin Splat Alignment Candidate.lnk" "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_RESTORE_SHORTCUT_REGISTERS
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
  !insertmacro METORIGIN_PRESERVE_SHORTCUT_REGISTERS
  !insertmacro METORIGIN_MIGRATE_OWNED_SHORTCUT "$DESKTOP\MetOrigin Splat Alignment Candidate.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_MIGRATE_OWNED_SHORTCUT "$SMPROGRAMS\MetOrigin Splat Alignment Candidate.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_MIGRATE_OWNED_SHORTCUT "$SMPROGRAMS\$AppStartMenuFolder\MetOrigin Splat Alignment Candidate.lnk" "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !insertmacro METORIGIN_RESTORE_SHORTCUT_REGISTERS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro METORIGIN_REQUIRE_STOPPED_PROCESSES
!macroend
