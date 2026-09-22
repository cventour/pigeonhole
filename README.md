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

```bash
git clone https://github.com/cventour/pigeonhole.git
cd pigeonhole
REPO_ROOT=/srv/files node server.js
```

Open http://localhost:3001.

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

## There is no authentication

Read that again before you expose it. Pigeonhole assumes it sits on a network
you trust, or behind something that does the authenticating. Anyone who can
reach it can upload, rename and delete.

That is a scope decision, not an oversight. Authentication done badly is worse
than none, and every reverse proxy already does it well: put it behind basic
auth, an OIDC proxy, a VPN, or a network you control.

It binds `127.0.0.1` by default so that exposing it takes a decision.

## Behind a reverse proxy

Every request the page makes is relative, so it works under any prefix. Two
things to get right:

```caddy
redir /files /files/          # the page resolves its API relative to the URL
handle_path /files/* {
	reverse_proxy 127.0.0.1:3001
}
```

The redirect matters: without the trailing slash, relative API calls resolve
against the site root and every request 404s.

nginx equivalent:

```nginx
location = /files { return 301 /files/; }
location /files/  { proxy_pass http://127.0.0.1:3001/; }
```

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

## Safety

Every client-supplied path is resolved and checked against the root before
use, so `../../etc` lands inside the managed directory rather than outside it.
Names for rename and mkdir must be a single path component — a separator is
refused rather than stripped. Filenames render as text, never as markup.

None of that substitutes for the authentication it does not have.

## systemd

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

## Licence

MIT.
