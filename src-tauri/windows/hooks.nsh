; OpenBlocker installer hooks (included by Tauri's NSIS template).
; Registers the background service and refuses to update or uninstall while a
; locked block is running.

!define OB_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

; Abort if a locked block or freeze is running. Only asked when the installed
; version already has the service (older versions don't know the flag and
; would simply open the app).
!macro OB_REFUSE_WHILE_LOCKED
  nsExec::Exec 'sc.exe query OpenBlocker'
  Pop $0
  ${If} $0 == 0
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-check'
    Pop $0
    ${If} $0 == 1
      MessageBox MB_ICONSTOP|MB_OK "A locked block is running in OpenBlocker.$\n$\nYou can update or uninstall OpenBlocker once it has ended." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro OB_REMOVE_SERVICE
  nsExec::Exec 'sc.exe stop OpenBlocker'
  Pop $0
  ; Give it a moment to exit and release the executable.
  Sleep 2000
  nsExec::Exec 'sc.exe delete OpenBlocker'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OB_REFUSE_WHILE_LOCKED
  !insertmacro OB_REMOVE_SERVICE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec 'sc.exe create OpenBlocker binPath= "\"$INSTDIR\${MAINBINARYNAME}.exe\" --service" start= auto DisplayName= "OpenBlocker"'
  Pop $0
  nsExec::Exec 'sc.exe description OpenBlocker "Keeps your OpenBlocker blocks active, even while the app is closed."'
  Pop $0
  ; Restart automatically if it crashes or gets killed.
  nsExec::Exec 'sc.exe failure OpenBlocker reset= 86400 actions= restart/2000/restart/2000/restart/5000'
  Pop $0
  nsExec::Exec 'sc.exe start OpenBlocker'
  Pop $0
  ; Versions before the service started at logon through an elevated
  ; scheduled task. The app doesn't need administrator rights any more, so
  ; move that to the normal per-user Run key.
  nsExec::Exec 'schtasks.exe /Query /TN OpenBlocker'
  Pop $0
  ${If} $0 == 0
    WriteRegStr HKCU "${OB_RUN_KEY}" "OpenBlocker" '"$INSTDIR\${MAINBINARYNAME}.exe" --minimized'
    nsExec::Exec 'schtasks.exe /Delete /TN OpenBlocker /F'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update already checked this before removing the old version.
  ${If} $UpdateMode <> 1
    !insertmacro OB_REFUSE_WHILE_LOCKED
  ${EndIf}
  !insertmacro OB_REMOVE_SERVICE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${OB_RUN_KEY}" "OpenBlocker"
    ; The service's data in ProgramData.
    ReadEnvStr $1 "ProgramData"
    ${If} $1 != ""
      RMDir /r "$1\OpenBlocker"
    ${EndIf}
  ${EndIf}
!macroend
