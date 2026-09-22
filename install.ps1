<#
.SYNOPSIS
    Pigeonhole installer for Windows PowerShell.

.DESCRIPTION
    There is nothing to build and nothing to install system-wide. This fetches
    the code, checks that Node is new enough, and starts the server.

.EXAMPLE
    .\install.ps1
    Install to $HOME\pigeonhole and run it.

.EXAMPLE
    .\install.ps1 -Dir C:\pigeonhole -Root D:\files -Bind 0.0.0.0
    Install to a chosen folder, serve D:\files, and accept connections from
    other machines on the network.

.EXAMPLE
    .\install.ps1 -NoStart
    Install only.
#>

[CmdletBinding()]
param(
    [string]$Dir   = (Join-Path $HOME 'pigeonhole'),
    [string]$Root,
    [int]   $Port,
    [string]$Bind,
    [string]$Title,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

$RepoUrl    = 'https://github.com/cventour/pigeonhole.git'
$TarballUrl = 'https://github.com/cventour/pigeonhole/archive/refs/heads/main.zip'
$NodeMin    = 20

function Step($text) { Write-Host "`n==> $text" }
function Say($text)  { Write-Host $text }
# Write-Error would throw a stack-trace block and swallow the exit code.
function Die($text)  { [Console]::Error.WriteLine("error: $text"); exit 1 }
function Have($cmd)  { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------- node check

Step 'Checking Node'
if (-not (Have 'node')) {
    Die "Node is not installed. Get it from https://nodejs.org (version $NodeMin or newer)."
}

$version = (& node --version)                       # v20.11.0
$major   = [int]($version.TrimStart('v').Split('.')[0])
if ($major -lt $NodeMin) {
    Die "Node $version is too old. Pigeonhole needs $NodeMin or newer."
}
Say "Node $version"

# ----------------------------------------------------------------- get code

Step "Fetching Pigeonhole into $Dir"

if (Test-Path (Join-Path $Dir 'server.js')) {
    if ((Test-Path (Join-Path $Dir '.git')) -and (Have 'git')) {
        & git -C $Dir pull --ff-only --quiet
        Say 'Updated the existing copy.'
    } else {
        Say 'Already there - leaving it alone.'
    }
}
elseif ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir | Select-Object -First 1)) {
    Die "$Dir exists and is not empty. Pick another path with -Dir."
}
elseif (Have 'git') {
    & git clone --depth 1 --quiet $RepoUrl $Dir
    if ($LASTEXITCODE -ne 0) { Die 'git clone failed.' }
    Say 'Cloned.'
}
else {
    # No git. A zip needs nothing that is not already in Windows.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $zip = Join-Path $tmp 'pigeonhole.zip'
        Invoke-WebRequest -Uri $TarballUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $src = Get-ChildItem -Directory $tmp | Where-Object Name -like 'pigeonhole-*' | Select-Object -First 1
        if (-not $src) { Die 'The download did not contain what it should.' }
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Dir -Recurse -Force
        Say 'Downloaded.'
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path (Join-Path $Dir 'server.js'))) {
    Die "server.js is missing from $Dir. The download did not complete."
}

# --------------------------------------------------------------------- run

# The server reads its settings from the environment, same as everywhere else.
if ($Root)  { $env:REPO_ROOT  = $Root }
if ($Port)  { $env:PORT       = "$Port" }
if ($Bind)  { $env:HOST       = $Bind }
if ($Title) { $env:REPO_TITLE = $Title }

Set-Location $Dir

if ($NoStart) {
    Step 'Installed'
    Say 'Start it whenever you like:'
    Say ''
    Say "  cd $Dir; node server.js"
    exit 0
}

$shownRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { Join-Path $Dir 'files' }
$shownHost = if ($env:HOST)      { $env:HOST }      else { '127.0.0.1' }
$shownPort = if ($env:PORT)      { $env:PORT }      else { '3001' }

Step 'Starting'
Say "Files:   $shownRoot"
Say "Address: http://${shownHost}:${shownPort}"
Say 'Stop it with Ctrl-C. To start it again later:'
Say ''
Say "  cd $Dir; node server.js"
Say ''

& node server.js
