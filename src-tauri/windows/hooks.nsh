!define WORK_HUB_HOOK_DIR "${__FILEDIR__}"

; Use the NEW helper from a temporary directory, before replacing any installed
; executable. It can authenticate and safely stop older protocol-0 backends too.
; Lock contention, a busy Git operation or failed authentication aborts the change.
!macro WORK_HUB_PREPARE_UPGRADE
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=work-hub-upgrade.exe "${WORK_HUB_HOOK_DIR}\..\binaries\work-hub-backend-x86_64-pc-windows-msvc.exe"
  nsExec::ExecToStack /TIMEOUT=25000 '"$PLUGINSDIR\work-hub-upgrade.exe" --prepare-upgrade'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP "Work Hub backend could not stop safely. Finish Git operations and choose Exit and stop backend, then retry. Custom --data profiles must also be stopped manually." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WORK_HUB_PREPARE_UPGRADE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WORK_HUB_PREPARE_UPGRADE
!macroend
