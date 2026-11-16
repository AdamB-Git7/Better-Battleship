# Builds Better Battleship (3D), copies it to its own EC2 server and restarts it.
#
#   .\deploy\deploy.ps1 -Server <elastic-ip>
#
# The first time, use -FirstInstall: it also installs Java and the systemd
# service on a fresh Amazon Linux 2023 server (see setup-server.sh).
#
# This version has its OWN server. The original 2D game (the interview
# project) lives on another server and must never be touched by this script.
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,
    [string]$Key = "$env:USERPROFILE\.ssh\battleship-key.pem",
    [switch]$FirstInstall
)

# Each step is checked with $LASTEXITCODE below. "Stop" is not used, because
# Windows PowerShell 5 treats any text a program writes to stderr (such as a
# harmless Maven warning) as a fatal error.
$ErrorActionPreference = "Continue"

# Safety: the original game's server.
$OriginalServer = "18.219.114.254"
if ($Server -eq $OriginalServer) {
    throw "$Server is the ORIGINAL Battleship server. This script only deploys the 3D version to its own server."
}

$Target = "ec2-user@$Server"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
    .\mvnw.cmd clean package
    if ($LASTEXITCODE -ne 0) { throw "Build or tests failed, nothing was deployed." }

    scp -i $Key target\battleship-0.0.1-SNAPSHOT.jar "${Target}:/tmp/battleship.jar"
    if ($LASTEXITCODE -ne 0) { throw "Copying the jar failed." }

    if ($FirstInstall) {
        scp -i $Key deploy\battleship.service deploy\setup-server.sh "${Target}:/tmp/"
        if ($LASTEXITCODE -ne 0) { throw "Copying the setup files failed." }
        ssh -i $Key $Target "bash /tmp/setup-server.sh"
        if ($LASTEXITCODE -ne 0) { throw "Setting up the server failed." }
    } else {
        ssh -i $Key $Target "sudo mv /tmp/battleship.jar /opt/battleship/battleship.jar && sudo chown battleship:battleship /opt/battleship/battleship.jar && sudo systemctl restart battleship && sudo systemctl is-active battleship"
        if ($LASTEXITCODE -ne 0) { throw "Restarting the game on the server failed." }
    }
} finally {
    Pop-Location
}

Write-Host "Deployed. Play at http://$Server"
