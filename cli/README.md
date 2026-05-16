# PeerMesh Provider CLI

PeerMesh Provider CLI shares your internet connection with PeerMesh from any machine that can run Node.js. It is the headless alternative to the desktop app and is designed for servers, terminals, background services, and automation.

The CLI exposes the same local helper API as the desktop app, so the dashboard and browser extension can detect it, read its status, update slot count, apply daily limits, and sync private sharing state.

## Requirements

- Node.js 18 or newer
- npm or npx
- A PeerMesh account
- Outbound access to the PeerMesh API and relay WebSocket endpoints

## Install

### Windows PowerShell

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @btcmaster1000/peermesh-provider
```

If winget is unavailable:

```powershell
Invoke-WebRequest https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -OutFile node.msi
Start-Process msiexec -ArgumentList '/i node.msi /quiet' -Wait
npm install -g @btcmaster1000/peermesh-provider
```

### macOS

```bash
brew install node
npm install -g @btcmaster1000/peermesh-provider
```

Without Homebrew:

```bash
curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg -o node.pkg
sudo installer -pkg node.pkg -target /
npm install -g @btcmaster1000/peermesh-provider
```

### Linux

Debian or Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g @btcmaster1000/peermesh-provider
```

Fedora:

```bash
sudo dnf install -y nodejs npm
npm install -g @btcmaster1000/peermesh-provider
```

## Run Without Installing

```bash
npx @btcmaster1000/peermesh-provider
```

## First Run

```bash
peermesh-provider
```

The first run opens a browser sign-in flow and prints a device code. Sign in, approve the device, then return to the terminal. After authentication, the CLI:

- starts a local control server on `127.0.0.1:7654`
- registers provider slots with the relay
- syncs dashboard profile data
- keeps usage, slot, limit, and private-sharing state current

## Status

```bash
peermesh-provider --status
```

The status output includes:

- signed-in user
- country
- configured slot count
- active or idle sharing state
- shared bytes for the current day
- request count for the current day
- daily limit
- profile sync actor and timestamp
- slot sync actor and timestamp
- per-slot status, bytes, private/public mode, private code, expiry, and sync actor

Example:

```text
User:          alice
Country:       NG
Slots:         2
Sharing:       active
Shared today:  264.3KB
Requests today: 4
Daily limit:   2048 MB
Profile sync:  DASHBOARD @ 14:29:45
Slot sync:     CLI @ 14:29:46

Slot state:
  Slot 1: RUNNING  req=3  served=120.1KB  mode=PUBLIC  code=---------  expiry=no expiry  sync=n/a
  Slot 2: RUNNING  req=1  served=144.2KB  mode=PRIVATE  code=123456789  expiry=no expiry  sync=DASHBOARD @ 14:30:00
```

## Command Reference

### Sharing

```bash
peermesh-provider
peermesh-provider --serve
```

`--serve` skips the interactive terms prompt, which is useful for scripts and services.

### Slots

```bash
peermesh-provider --slots 4
peermesh-provider --slot 4
```

Slots are independent relay connections for concurrent provider capacity.

- valid range: `1` to `32`
- `1` to `8`: typical home connections
- `9` to `16`: stable broadband
- `17` to `32`: dedicated or server-grade connections

Slot count syncs with the dashboard, desktop app, and extension helper state. If the server sync reduces slot count, stale private-share rows beyond the active slot count are trimmed from CLI status and local helper state.

### Daily Limit

```bash
peermesh-provider --limit 1024
peermesh-provider --no-limit
```

Limits are in MB per day. When the daily limit is reached, sharing pauses and resumes after the local daily reset.

### Private Sharing

```bash
peermesh-provider --private-status
peermesh-provider --private-on
peermesh-provider --private-off
peermesh-provider --private-refresh
peermesh-provider --private-slot 2 --private-on
peermesh-provider --private-slot 2 --private-expiry 24
peermesh-provider --private-slot 2 --private-expiry none
```

Private sharing is per slot:

- each slot has its own code
- private slots are available only to code holders
- public slots stay available to eligible public requesters
- expiry is in hours, or `none`
- code refresh keeps the slot private and rotates the code

### Account and Debugging

```bash
peermesh-provider --reset
peermesh-provider --debug
peermesh-provider --docs
```

`--reset` clears saved credentials and revokes the device session when the API is reachable.

Debug logs are written to:

- Windows: `%USERPROFILE%\Desktop\peermesh-debug.log`
- macOS/Linux: `~/Desktop/peermesh-debug.log`

Config is stored in:

- Windows: `%USERPROFILE%\.peermesh`
- macOS/Linux: `~/.peermesh`

## Sync Model

The CLI syncs with the dashboard, desktop app, extension, and API.

- `GET /api/user/sharing` pulls profile, daily limit, slot count, private shares, and per-slot limits.
- `POST /api/user/sharing` persists local sharing state, slot count, private sharing changes, and bytes served.
- The local control API on `127.0.0.1:7654` lets dashboard and extension read and update helper state.
- When both desktop and CLI are installed, only one can own port `7654`; the other may use the peer helper port when supported.

The status output shows sync actors such as `DASHBOARD`, `CLI`, `DESKTOP`, `EXTENSION`, or `SYSTEM`.

## Keep It Running

### Linux systemd

```bash
sudo tee /etc/systemd/system/peermesh.service <<EOF
[Unit]
Description=PeerMesh Provider
After=network.target

[Service]
ExecStart=$(which peermesh-provider) --serve
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now peermesh.service
```

### macOS launchd

```bash
cat > ~/Library/LaunchAgents/app.peermesh.provider.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.peermesh.provider</string>
  <key>ProgramArguments</key><array>
    <string>$(which peermesh-provider)</string>
    <string>--serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/app.peermesh.provider.plist
```

### Windows Task Scheduler

```powershell
$provider = (Get-Command peermesh-provider).Source
$action = New-ScheduledTaskAction -Execute $provider -Argument "--serve"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "PeerMesh Provider" -Action $action -Trigger $trigger -RunLevel Highest -Force
```

## Troubleshooting

### Dashboard does not show CLI

Run:

```bash
peermesh-provider --status
```

If it says sign-in is required, authenticate again with:

```bash
peermesh-provider
```

If another app owns the helper port, close the desktop app or the other CLI process.

### Slots look stale after reducing count

Run:

```bash
peermesh-provider --status
```

The CLI should show only the synced configured slots. If the dashboard still shows a stale count, refresh the dashboard after the next helper sync.

### Private code is not accepted

Check:

```bash
peermesh-provider --private-status
```

Confirm the intended slot is `ACTIVE`, the code has not expired, and the requester is using private-code mode instead of a public country connection.

### Auth was revoked

If the server revokes the CLI device, status commands exit cleanly with a sign-in-required message. Run:

```bash
peermesh-provider
```

## Uninstall

```bash
npm uninstall -g @btcmaster1000/peermesh-provider
```

Remove saved credentials and config:

```bash
rm -rf ~/.peermesh
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.peermesh"
```

Remove background service first if configured:

```bash
sudo systemctl disable --now peermesh.service
sudo rm /etc/systemd/system/peermesh.service
```

```bash
launchctl unload ~/Library/LaunchAgents/app.peermesh.provider.plist
rm ~/Library/LaunchAgents/app.peermesh.provider.plist
```

```powershell
Unregister-ScheduledTask -TaskName "PeerMesh Provider" -Confirm:$false
```
