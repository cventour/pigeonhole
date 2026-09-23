# Pigeonhole

A file pigeonhole you can stand up in a minute. Put files in, let people take
them out, and take back whatever they leave you.

Useful when a group needs a shared drop: distributing builds, installers or
documents to a handful of machines, and collecting files back from them
without email, chat attachments or a cloud account.

Drag files in or browse for them, with a progress bar on each. Browse folders,
rename, delete, download, make folders. That is the whole feature list and it
is meant to stay short.

**No dependencies.** Node's standard library and nothing else. No install
step, no lockfile, nothing to update when someone else's package goes wrong.

## Requirements

Node 20 or newer, on any platform it runs on. That is the entire list.

```
node --version
```

Then follow whichever section below matches your machine. Each one is
self-contained: install, run, share, keep running.

---

# macOS and Linux

Also WSL, and anything else with bash.

## Install it

```bash
curl -fsSL https://raw.githubusercontent.com/cventour/pigeonhole/main/install.sh -o install.sh
```

Read it — it is about a hundred lines and does nothing surprising. Then:

```bash
bash install.sh
```

It installs to `~/pigeonhole`, checks your Node version, and starts the
server. Open http://localhost:3001.

Options:

| Option | Meaning |
|---|---|
| `--dir` | Where to install. Default `~/pigeonhole`. |
| `--root` | The directory to serve. Default `<install dir>/files`. |
| `--port` | Default `3001`. |
| `--host` | Bind address. Default `127.0.0.1`. |
| `--title` | Page heading. |
| `--no-start` | Install without starting. |

So to serve a folder you already have, to the whole network:

```bash
bash install.sh --root /srv/files --host 0.0.0.0
```

Run the script again later and it updates the copy it installed.

## Run it by hand

The script saves typing, not much else. The manual version is three lines:

```bash
git clone https://github.com/cventour/pigeonhole.git
cd pigeonhole
node server.js
```

Files land in `./files`, created on first run.

## Serve a folder you already have

Settings are environment variables. Set them inline for one run:

```bash
REPO_ROOT=/srv/files node server.js
```

Or for the whole shell session:

```bash
export REPO_ROOT=/srv/files REPO_TITLE="Team Drop"
```

The path can be anywhere the user running the process can read and write — an
external drive, a home directory, a network mount.

## Let other machines reach it

It binds `127.0.0.1`, so by default only this machine can reach it. To open it
to the network, bind all interfaces:

```bash
HOST=0.0.0.0 PORT=3001 REPO_ROOT=/srv/files node server.js
```

Find the address to hand out — macOS:

```bash
ipconfig getifaddr en0
```

Linux:

```bash
hostname -I
```

Others open `http://<that-address>:3001`. Read
[There is no authentication](#there-is-no-authentication) before you do this.

## Keep it running

The shell that started it owns it. To survive a closed terminal:

```bash
nohup env REPO_ROOT=/srv/files node server.js > pigeonhole.log 2>&1 &
```

**Linux, with systemd.** Save as `/etc/systemd/system/pigeonhole.service`:

```ini
[Unit]
Description=Pigeonhole
After=network.target

[Service]
Type=simple
User=pigeonhole
WorkingDirectory=/opt/pigeonhole
ExecStart=/usr/bin/node /opt/pigeonhole/server.js
Environment=REPO_ROOT=/srv/files
# Quote any value containing a space: systemd splits unquoted ones.
Environment="REPO_TITLE=Team Drop"
Restart=on-failure

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/files

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pigeonhole
```

```bash
systemctl status pigeonhole
```

**macOS, with launchd.** Save as
`~/Library/LaunchAgents/com.pigeonhole.plist`, with your own paths — launchd
does not expand `~`, and needs the full path to node:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.pigeonhole</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/pigeonhole/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_ROOT</key>        <string>/Users/you/Shared</string>
    <key>REPO_TITLE</key>       <string>Team Drop</string>
  </dict>
  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>          <true/>
  <key>StandardErrorPath</key>  <string>/tmp/pigeonhole.log</string>
</dict>
</plist>
```

`which node` gives the path to use. Then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pigeonhole.plist
```

```bash
launchctl print gui/$(id -u)/com.pigeonhole
```

To stop it for good:

```bash
launchctl bootout gui/$(id -u)/com.pigeonhole
```

---

# Windows

PowerShell throughout. Every command works in Windows PowerShell 5.1 and in
PowerShell 7.

## Install it

```powershell
irm https://raw.githubusercontent.com/cventour/pigeonhole/main/install.ps1 -OutFile install.ps1
```

Read it — it is about a hundred lines and does nothing surprising. Then:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Windows blocks downloaded scripts by default, which is why that is longer than
`.\install.ps1`. It applies to this one run and changes nothing on the machine.

It installs to `$HOME\pigeonhole`, checks your Node version, and starts the
server. Open http://localhost:3001.

Options:

| Option | Meaning |
|---|---|
| `-Dir` | Where to install. Default `$HOME\pigeonhole`. |
| `-Root` | The directory to serve. Default `<install dir>\files`. |
| `-Port` | Default `3001`. |
| `-Bind` | Bind address. Default `127.0.0.1`. |
| `-Title` | Page heading. |
| `-NoStart` | Install without starting. |

So to serve a folder you already have, to the whole network:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Root D:\files -Bind 0.0.0.0
```

The switch is `-Bind` rather than `-Host` because `$Host` is a variable
PowerShell reserves for itself.

Run the script again later and it updates the copy it installed.

## Run it by hand

The script saves typing, not much else. The manual version is three lines:

```powershell
git clone https://github.com/cventour/pigeonhole.git
cd pigeonhole
node server.js
```

Windows does not ship with git, so on a fresh machine that first line fails.
Take the zip instead — this needs nothing that is not already there:

```powershell
irm https://github.com/cventour/pigeonhole/archive/refs/heads/main.zip -OutFile pigeonhole.zip
Expand-Archive pigeonhole.zip -DestinationPath .
cd pigeonhole-main
node server.js
```

Files land in `.\files`, created on first run.

## Serve a folder you already have

Settings are environment variables. PowerShell sets them on their own line —
the `REPO_ROOT=... node server.js` form you see in Unix instructions is not
valid here:

```powershell
$env:REPO_ROOT = "D:\files"
node server.js
```

They last as long as the window. To set one for good, for your account:

```powershell
[Environment]::SetEnvironmentVariable("REPO_ROOT", "D:\files", "User")
```

Open a new PowerShell window for that to take effect.

## Let other machines reach it

It binds `127.0.0.1`, so by default only this machine can reach it. To open it
to the network, bind all interfaces:

```powershell
$env:HOST = "0.0.0.0"; $env:REPO_ROOT = "D:\files"; node server.js
```

Find the address to hand out:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -notlike '127.*' | Select-Object InterfaceAlias, IPAddress
```

Windows Firewall will block the port even once it is bound, and the prompt is
easy to miss. Allow it from an **administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Pigeonhole" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow
```

Others open `http://<that-address>:3001`. Read
[There is no authentication](#there-is-no-authentication) before you do this.

To close it again afterwards:

```powershell
Remove-NetFirewallRule -DisplayName "Pigeonhole"
```

## Keep it running

The window that started it owns it. To put it in the background for this
session:

```powershell
$p = Start-Process node -ArgumentList "server.js" -WorkingDirectory "$HOME\pigeonhole" -WindowStyle Hidden -PassThru
```

`-PassThru` hands back the process, so you can stop it again:

```powershell
Stop-Process -Id $p.Id
```

To survive a reboot, register a scheduled task from an **administrator**
PowerShell. Install it somewhere outside your profile first, since the task
runs as SYSTEM:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Dir C:\pigeonhole -NoStart
```

Set every setting you need machine-wide, because SYSTEM does not see your
account's variables:

```powershell
[Environment]::SetEnvironmentVariable("REPO_ROOT", "D:\files", "Machine")
[Environment]::SetEnvironmentVariable("HOST", "0.0.0.0", "Machine")
```

```powershell
$action  = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "server.js" -WorkingDirectory "C:\pigeonhole"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName Pigeonhole -Action $action -Trigger $trigger -User SYSTEM -RunLevel Highest
```

`(Get-Command node).Source` resolves the full path to node.exe, because SYSTEM
does not necessarily share your `PATH`.

Start it now rather than waiting for a reboot:

```powershell
Start-ScheduledTask -TaskName Pigeonhole
```

```powershell
Get-ScheduledTask -TaskName Pigeonhole | Get-ScheduledTaskInfo
```

A `LastTaskResult` of `267009` is not an error — it is `0x41301`, "the task is
currently running", which is what you want to see.

Stop it, or remove it entirely:

```powershell
Stop-ScheduledTask -TaskName Pigeonhole
```

```powershell
Unregister-ScheduledTask -TaskName Pigeonhole -Confirm:$false
```

---

## Configuration

All optional, all environment variables, identical on every platform.

| Variable | Default | Purpose |
|---|---|---|
| `REPO_ROOT` | `./files` | The directory it manages. Created if missing. |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default, on purpose. |
| `PORT` | `3001` | |
| `REPO_TITLE` | `Pigeonhole` | Page title and heading |
| `REPO_SUBTITLE` | `Drop files in. Take files out.` | Line under the heading |

Branding is configuration rather than code, so one copy serves any deployment.

How you set them is the only thing that differs:

| | macOS and Linux | Windows |
|---|---|---|
| One run | `REPO_ROOT=/srv/files node server.js` | `$env:REPO_ROOT = "D:\files"` then `node server.js` |
| This session | `export REPO_ROOT=/srv/files` | `$env:REPO_ROOT = "D:\files"` |
| Permanently | put the `export` in `~/.zshrc` or `~/.bashrc` | `[Environment]::SetEnvironmentVariable("REPO_ROOT", "D:\files", "User")` |

## There is no authentication

Read that again before you expose it. Anyone who can reach it can upload,
rename and delete. Pigeonhole assumes it sits on a network you trust — a home
or office LAN, a VPN, a lab segment.

That is a scope decision, not an oversight. Authentication done badly is worse
than none, so it does none and says so plainly.

It binds `127.0.0.1` by default so that exposing it takes a decision.

## Safety

Every client-supplied path is resolved and checked against the root before
use, so `../../etc` lands inside the managed directory rather than outside it.
Names for rename and mkdir must be a single path component — a separator is
refused rather than stripped. Filenames render as text, never as markup.

None of that substitutes for the authentication it does not have.

## Design notes

Three choices worth explaining, because each looks wrong at first glance.

**Uploads are a raw `PUT` body, not `multipart/form-data`.** Multipart is the
conventional answer and would need a parser — the one dependency this would
otherwise have. A raw body streams straight to disk, so a four-gigabyte file
never lands in memory, and there is nothing to audit or update.

**Uploads use `XMLHttpRequest`, not `fetch`.** `fetch` still cannot report
upload progress. A large upload with no progress bar is indistinguishable from
a hang, so XHR stays until browsers fix that.

**Files upload to `<name>.part` and are renamed on completion.** An
interrupted transfer then leaves nothing behind, rather than a truncated file
that looks complete until something tries to use it.

## Licence

MIT.
