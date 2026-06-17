!macro customInstall
  ReadEnvStr $0 "ProgramData"
  StrCmp $0 "" 0 +2
  StrCpy $0 "$APPDATA"
  CreateDirectory "$0\KabinetteNotes"
  nsExec::ExecToLog 'icacls "$0\KabinetteNotes" /grant *S-1-5-32-545:(OI)(CI)M /T /C'
  SetOutPath "$0\KabinetteNotes"
  File /oname=client-update-task.ps1 "${BUILD_RESOURCES_DIR}\client-update-task.ps1"
  nsExec::ExecToLog 'schtasks /Create /TN "KabinetteClientUpdate" /SC ONCE /ST 00:00 /RL HIGHEST /RU SYSTEM /F /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$0\KabinetteNotes\client-update-task.ps1\""'
  SetOutPath "$INSTDIR"
  IfFileExists "$INSTDIR\KabinetteUpdaterService.exe" service_ready 0
  File /oname=KabinetteUpdaterService.exe "${BUILD_RESOURCES_DIR}\KabinetteUpdaterService.exe"
  nsExec::ExecToLog 'sc create KabinetteUpdater binPath= "\"$INSTDIR\KabinetteUpdaterService.exe\"" start= auto DisplayName= "Kabinette Updater"'
  nsExec::ExecToLog 'sc description KabinetteUpdater "Installs Kabinette Notes Client updates with local SYSTEM permissions."'
service_ready:
  nsExec::ExecToLog 'sc start KabinetteUpdater'
  SetRegView 64
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Kabinette Notes Client" '"$INSTDIR\Kabinette Notes Client.exe"'
  SetRegView lastused
!macroend

!macro customUnInstall
  SetRegView 64
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Kabinette Notes Client"
  SetRegView lastused
  nsExec::ExecToLog 'schtasks /Delete /TN "KabinetteClientUpdate" /F'
!macroend
