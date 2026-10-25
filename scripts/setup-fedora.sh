#!/usr/bin/env bash
# Sets up the Bucky BudgetR dev environment on Fedora (tested on Fedora 44).
# Safe to re-run: every step checks before changing anything.
# Usage: ./scripts/setup-fedora.sh   (asks for your sudo password)
set -euo pipefail

NODE_MAJOR=24

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "VS Code (Microsoft RPM repo)"
if [ ! -f /etc/yum.repos.d/vscode.repo ]; then
    sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc
    printf '%s\n' \
        '[code]' \
        'name=Visual Studio Code' \
        'baseurl=https://packages.microsoft.com/yumrepos/vscode' \
        'enabled=1' \
        'autorefresh=1' \
        'type=rpm-md' \
        'gpgcheck=1' \
        'gpgkey=https://packages.microsoft.com/keys/microsoft.asc' |
        sudo tee /etc/yum.repos.d/vscode.repo >/dev/null
fi

step "Docker Engine repo"
if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
    sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
fi

if rpm -q docker-desktop >/dev/null 2>&1; then
    step "Removing Docker Desktop (replaced by native Docker Engine)"
    systemctl --user disable --now docker-desktop 2>/dev/null || true
    sudo dnf remove -y docker-desktop
fi

step "Packages: VS Code, Go, Node.js ${NODE_MAJOR}, Docker Engine"
sudo dnf install -y \
    code \
    golang \
    "nodejs${NODE_MAJOR}" "nodejs${NODE_MAJOR}-bin" "nodejs${NODE_MAJOR}-npm-bin" \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

step "Docker daemon and group"
sudo systemctl enable --now docker
if ! id -nG "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    echo "Added $USER to the docker group. Log out and back in for this to take effect."
fi
docker context use default >/dev/null 2>&1 || true

step "Go binaries on PATH"
mkdir -p ~/.bashrc.d
if [ ! -f ~/.bashrc.d/go.sh ]; then
    echo 'export PATH="$PATH:$(go env GOPATH)/bin"' >~/.bashrc.d/go.sh
fi

step "VS Code extensions"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
grep -oE '"[A-Za-z0-9-]+\.[A-Za-z0-9-]+"' "$repo_root/.vscode/extensions.json" | tr -d '"' |
    while read -r ext; do
        # --no-deprecation hides a harmless url.parse() warning from VS Code's own CLI
        NODE_OPTIONS=--no-deprecation code --install-extension "$ext" --force >/dev/null && echo "  $ext"
    done

step "Versions"
code --version | head -1 | sed 's/^/code     /'
go version
echo "node     $(node -v)"
echo "npm      $(npm -v)"
docker compose version
echo
if sg docker -c 'docker run --rm hello-world' >/dev/null 2>&1; then
    echo "Docker works (hello-world ran)."
else
    echo "Docker test failed. Check: systemctl status docker"
    exit 1
fi
