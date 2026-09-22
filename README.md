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

Node 20 or newer. That is the entire list.

```bash
node --version
```

## Install and run

A script for each platform. Both fetch the code, check your Node version and
start the server. Neither installs anything system-wide or needs admin rights.

macOS, Linux, WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/cventour/pigeonhole/main/install.sh -o install.sh
```

```bash
bash install.sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/cventour/pigeonhole/main/install.ps1 -OutFile install.ps1
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Windows blocks downloaded scripts by default, which is why that second command
is longer than `./install.ps1`. It applies to this one run only and changes
nothing on the machine.

Read the script before you run it. It is about a hundred lines and does
nothing surprising.

Both take the same options:

| Option | Meaning |
|---|---|
| `--dir` / `-Dir` | Where to install. Default `~/pigeonhole`. |
| `--root` / `-Root` | The directory to serve. Default `<install dir>/files`. |
| `--port` / `-Port` | Default `3001`. |
| `--host` / `-Bind` | Bind address. Default `127.0.0.1`. |
| `--title` / `-Title` | Page heading. |
| `--no-start` / `-NoStart` | Install without starting. |

So to serve an existing folder to the whole network:

```bash
bash install.sh --root /srv/files --host 0.0.0.0
```

Run the script again later and it updates the copy it installed.

## Run it by hand

The scripts save typing, not much else. The manual version is three lines:

```bash
git clone https://github.com/cventour/pigeonhole.git
cd pigeonhole
node server.js
```

Open http://localhost:3001. Files land in `./files`, created on first run.

To serve a directory that already exists, point `REPO_ROOT` at it:

```bash
REPO_ROOT=/srv/files node server.js
```

The path can be anywhere the user running the process can read and write — an
external drive, a home directory, a network mount.

## Let other machines reach it

By default it binds `127.0.0.1`, so only the machine it runs on can reach it.
To open it to the network, bind all interfaces:

```bash
HOST=0.0.0.0 PORT=3001 REPO_ROOT=/srv/files node server.js
```

Then find the address to hand out:

```bash
ipconfig getifaddr en0          # macOS
hostname -I                     # Linux
```

Others open `http://<that-address>:3001`. Read **There is no authentication**
below before you do this.

## Keep it running

Nothing here needs a supervisor, but the shell that started it owns it. To
survive a closed terminal:

```bash
nohup env REPO_ROOT=/srv/files node server.js > pigeonhole.log 2>&1 &
```

On a machine with systemd, a unit is tidier. Save as
`/etc/systemd/system/pigeonhole.service`:

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

## Configuration

All optional, all environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `REPO_ROOT` | `./files` | The directory it manages. Created if missing. |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default, on purpose. |
| `PORT` | `3001` | |
| `REPO_TITLE` | `Pigeonhole` | Page title and heading |
| `REPO_SUBTITLE` | `Drop files in. Take files out.` | Line under the heading |

Branding is configuration rather than code, so one copy serves any deployment.

Set them inline for a one-off run, or export them for the session:

```bash
export REPO_ROOT=/srv/files REPO_TITLE="Team Drop" HOST=0.0.0.0
```

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

**The browser uses `XMLHttpRequest`, not `fetch`.** `fetch` still cannot
report upload progress. A large upload with no progress bar is
indistinguishable from a hang, so XHR stays until browsers fix that.

**Files upload to `<name>.part` and are renamed on completion.** An
interrupted transfer then leaves nothing behind, rather than a truncated file
that looks complete until something tries to use it.

## Licence

MIT.
