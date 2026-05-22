; PeerMesh installer/uninstaller hooks

!macro IsPeerMeshRunning RESULT
  nsExec::ExecToStack '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.ProcessName -eq ''PeerMesh'' -or $$_.ProcessName -like ''PeerMesh Helper*'' }) { exit 0 } else { exit 1 }"'
  Pop ${RESULT}
  Pop $R3
!macroend

; Shared macro to kill all PeerMesh processes cleanly
!macro KillPeerMesh
  !insertmacro IsPeerMeshRunning $R0
  ${If} $R0 != "0"
    DetailPrint "No running PeerMesh process found."
  ${Else}
  ; 1. Ask both possible control ports to quit gracefully
  nsExec::ExecToLog '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NonInteractive -WindowStyle Hidden -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:7654/quit -Method POST -TimeoutSec 2 -UseBasicParsing | Out-Null } catch {}; try { Invoke-WebRequest -Uri http://127.0.0.1:7656/quit -Method POST -TimeoutSec 2 -UseBasicParsing | Out-Null } catch {}"'
  Sleep 2500

  ; 2. Force-kill any remaining Electron processes by name
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (GPU).exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (Renderer).exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (Plugin).exe" /T'
  nsExec::ExecToLog '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.ProcessName -eq ''PeerMesh'' -or $$_.ProcessName -like ''PeerMesh Helper*'' } | Stop-Process -Force -ErrorAction SilentlyContinue"'

  ; 3. Wait until the process is actually gone (poll up to 10s)
  ; nsExec::ExecToStack pushes: exit-code then stdout — pop both, check exit code
  ; tasklist exits 0 when it finds a match, 1 when nothing matches
  StrCpy $R1 0
  ${Do}
    Sleep 500
    !insertmacro IsPeerMeshRunning $R2
    ${If} $R2 != "0"
      ${Break}  ; process gone
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      ${Break}
    ${EndIf}
  ${Loop}
  ${EndIf}
!macroend

; customInit runs before electron-builder's own CloseApplications/uninstall flow.
; Stop the tray process early so upgrades do not hit locked app files.
!macro customInit
  DetailPrint "Preparing PeerMesh for update..."
  !insertmacro KillPeerMesh
!macroend

; customInstall fires after NSIS's CloseApplications step but before files are written.
; Killing here ensures the process is gone before NSIS tries to overwrite locked files.
!macro customInstall
  DetailPrint "Stopping any running PeerMesh instance..."
  !insertmacro KillPeerMesh
!macroend

; Shared macro to remove all PeerMesh artifacts
!macro CleanPeerMeshArtifacts
  ; Electron userData (config, logs, cache)
  RMDir /r "$APPDATA\peermesh-desktop"
  RMDir /r "$APPDATA\PeerMesh"

  ; Updater/cache folders left behind by previous installs
  RMDir /r "$LOCALAPPDATA\peermesh-desktop-updater"
  RMDir /r "$LOCALAPPDATA\PeerMesh-updater"

  ; Native messaging host manifests written by registerNativeMessagingHost()
  Delete "$APPDATA\Google\Chrome\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Google\Chrome Beta\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Google\Chrome Dev\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Chromium\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Microsoft\Edge\NativeMessagingHosts\com.peermesh.desktop.json"

  ; Native messaging registry keys written by registerNativeMessagingHost()
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.peermesh.desktop"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.peermesh.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.peermesh.desktop"

  ; Login item written by app.setLoginItemSettings({ openAtLogin: true })
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeerMesh"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "peermesh-desktop"

  ; Startup shortcut that Electron may have created
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\PeerMesh.lnk"
  RMDir /r "$SMPROGRAMS\PeerMesh"
!macroend

!macro CleanPeerMeshInstallDirs
  RMDir /r "$LOCALAPPDATA\Programs\PeerMesh"
  RMDir /r "$LOCALAPPDATA\Programs\peermesh-desktop"
  RMDir /r "$PROGRAMFILES\PeerMesh"
  RMDir /r "$PROGRAMFILES64\PeerMesh"
!macroend

!macro customUnInstall
  DetailPrint "Stopping PeerMesh..."
  !insertmacro KillPeerMesh
  DetailPrint "Removing PeerMesh files and registry entries..."
  !insertmacro CleanPeerMeshArtifacts
  !insertmacro CleanPeerMeshInstallDirs
!macroend
