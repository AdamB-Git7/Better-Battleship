#!/bin/bash
# One-time setup of a fresh Amazon Linux 2023 server for Better Battleship (3D).
# Expects /tmp/battleship.jar and /tmp/battleship.service (deploy.ps1 -FirstInstall copies them).
set -euo pipefail

# Java 21 (Amazon Corretto), without the desktop parts.
if ! command -v java >/dev/null 2>&1; then
    sudo dnf install -y java-21-amazon-corretto-headless
fi

# A system user with no login, so the game does not run as root.
if ! id battleship >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /sbin/nologin battleship
fi

sudo mkdir -p /opt/battleship
sudo mv /tmp/battleship.jar /opt/battleship/battleship.jar
sudo chown -R battleship:battleship /opt/battleship

sudo mv /tmp/battleship.service /etc/systemd/system/battleship.service
sudo systemctl daemon-reload
sudo systemctl enable --now battleship
sudo systemctl status battleship --no-pager
