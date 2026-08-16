#!/usr/bin/env bash
#
# Deploy the Solana sniper onto a fresh Ubuntu 22.04 Proxmox VE LXC.
# Run as root inside the container:
#   bash deploy.sh
#
set -euo pipefail

APP_NAME="solana-sniper"
APP_DIR="/opt/${APP_NAME}"
APP_USER="sniper"
NODE_VERSION="20"
NVM_VERSION="v0.40.1"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "Run as root inside the LXC."

[[ -r /etc/os-release ]] || die "/etc/os-release not readable — cannot verify the OS."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04) ;;
  *) die "This script targets Ubuntu 22.04 or 24.04. Found: ${PRETTY_NAME:-unknown}" ;;
esac
log "OS confirmed: ${PRETTY_NAME}"

[[ -f "${SRC_DIR}/package.json" ]] || die "package.json not found next to deploy.sh."

# --- packages ----------------------------------------------------------------

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git bzip2 jq rsync >/dev/null

# --- user --------------------------------------------------------------------

if id -u "${APP_USER}" >/dev/null 2>&1; then
  log "User '${APP_USER}' already exists"
else
  log "Creating unprivileged user '${APP_USER}'"
  # No login shell for a service account that only ever runs under systemd,
  # but a real home is needed because nvm installs there.
  useradd --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi
APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"

# --- node via nvm ------------------------------------------------------------

NVM_DIR="${APP_HOME}/.nvm"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
  log "nvm already installed at ${NVM_DIR}"
else
  log "Installing nvm ${NVM_VERSION} for ${APP_USER}"
  runuser -u "${APP_USER}" -- bash -c \
    "export NVM_DIR='${NVM_DIR}'; \
     curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash" \
    >/dev/null
fi

log "Installing Node.js ${NODE_VERSION}"
runuser -u "${APP_USER}" -- bash -c \
  "export NVM_DIR='${NVM_DIR}'; . '${NVM_DIR}/nvm.sh'; nvm install ${NODE_VERSION} >/dev/null; nvm alias default ${NODE_VERSION} >/dev/null"

NODE_BIN="$(runuser -u "${APP_USER}" -- bash -c \
  "export NVM_DIR='${NVM_DIR}'; . '${NVM_DIR}/nvm.sh'; nvm which ${NODE_VERSION}")"
[[ -x "${NODE_BIN}" ]] || die "Could not resolve the node binary after install."
NODE_BIN_DIR="$(dirname "${NODE_BIN}")"
log "Node: $("${NODE_BIN}" --version) at ${NODE_BIN}"

# --- solana cli (for keygen) -------------------------------------------------

# The Solana CLI is OPTIONAL. It is only ever used for `solana-keygen`, and
# `npm run keygen` covers that without the dependency. Both release.solana.com
# and release.anza.xyz are unreachable from some egress paths (notably the VPN
# this host runs behind), so a failure here is expected and must not be fatal.
if command -v solana-keygen >/dev/null 2>&1; then
  log "Solana CLI already present: $(solana-keygen --version 2>/dev/null || echo unknown)"
else
  log "Trying the optional Solana CLI (not required — 'npm run keygen' replaces it)"
  if timeout 60 sh -c "$(curl -sSfL --max-time 30 https://release.anza.xyz/stable/install 2>/dev/null)" >/dev/null 2>&1 \
     || timeout 60 sh -c "$(curl -sSfL --max-time 30 https://release.solana.com/stable/install 2>/dev/null)" >/dev/null 2>&1; then
    SOLANA_BIN_DIR="${HOME}/.local/share/solana/install/active_release/bin"
    if [[ -x "${SOLANA_BIN_DIR}/solana-keygen" ]]; then
      ln -sf "${SOLANA_BIN_DIR}/solana-keygen" /usr/local/bin/solana-keygen
      ln -sf "${SOLANA_BIN_DIR}/solana" /usr/local/bin/solana
      log "Solana CLI installed: $(solana-keygen --version 2>/dev/null || echo ok)"
    fi
  else
    log "Solana CLI unreachable from this host — skipping. Use 'npm run keygen' instead."
  fi
fi

# --- application -------------------------------------------------------------

log "Installing application to ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'logs' \
  --exclude 'data' \
  --exclude '.env' \
  "${SRC_DIR}/" "${APP_DIR}/"

mkdir -p "${APP_DIR}/logs" "${APP_DIR}/data"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# Install the FULL tree (TypeScript is needed to build), build, then drop the dev
# dependencies. Do not try to install --omit=dev and then layer the build tools
# on top: npm reconciles the two trees badly and esbuild's install script dies
# with a misleading "spawn sh ENOENT" against a directory it never created.
log "Installing npm dependencies and building"
INSTALL_CMD="npm ci --no-audit --no-fund"
if [[ ! -f "${APP_DIR}/package-lock.json" ]]; then
  warn "No package-lock.json — falling back to 'npm install' (versions are not pinned)."
  INSTALL_CMD="npm install --no-audit --no-fund"
fi

# Note the DOUBLE quotes around the PATH value. Single quotes stop $PATH
# expanding, leaving it as the literal four characters, which silently strips
# /bin and /usr/bin from the child shell — npm still runs via the nvm prefix but
# plain `rm` dies with "command not found".
runuser -u "${APP_USER}" -- bash -c \
  "cd '${APP_DIR}' && export PATH=\"${NODE_BIN_DIR}:\$PATH\" && rm -rf node_modules && ${INSTALL_CMD} && npm run build && npm prune --omit=dev"

[[ -f "${APP_DIR}/dist/bot.js" ]] || die "Build produced no dist/bot.js."

# --- configuration -----------------------------------------------------------

if [[ -f "${APP_DIR}/.env" ]]; then
  log ".env already exists — left untouched"
else
  log "Creating .env from .env.example"
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
fi
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

# --- systemd -----------------------------------------------------------------

log "Installing systemd unit"
install -m 644 "${APP_DIR}/${APP_NAME}.service" "/etc/systemd/system/${APP_NAME}.service"
# Point ExecStart at the node binary nvm actually installed.
sed -i "s|^ExecStart=.*|ExecStart=${NODE_BIN} dist/bot.js|" "/etc/systemd/system/${APP_NAME}.service"
systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null

# --- logrotate ---------------------------------------------------------------

cat > "/etc/logrotate.d/${APP_NAME}" <<EOF
${APP_DIR}/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ${APP_USER} ${APP_USER}
}
EOF

# --- done --------------------------------------------------------------------

cat <<EOF

================================================================================
 Deployed to ${APP_DIR}

 NOT STARTED YET. The service is enabled but stopped, because .env is still
 the unedited template and starting now would do nothing useful.

 NEXT STEPS
 ----------
 1. Generate a dedicated wallet (do NOT reuse a wallet holding anything else):

      cd ${APP_DIR} && sudo -u ${APP_USER} env PATH="${NODE_BIN_DIR}:\$PATH" npm run keygen

    This writes the secret to ${APP_DIR}/data/wallet.json (mode 600) and prints
    ONLY the public key. It then tells you how to load it into .env without the
    secret ever appearing on screen. Do not cat the key and paste it by hand.

    (solana-keygen also works if the Solana CLI installed above, but its release
    servers are unreachable from some egress paths, hence the built-in command.)

 2. Get a free RPC key at https://helius.dev and set SOLANA_RPC_URL.
    The public RPC will not survive this workload.

 3. Edit the config:

      nano ${APP_DIR}/.env

    Leave DRY_RUN=true.

 4. Fund the wallet ONLY when you are ready to trade for real:
      - USDC: MAX_POSITIONS x POSITION_SIZE_USDC  (default 5 x \$25 = \$125)
      - SOL:  0.1 SOL minimum, for transaction fees

 5. Start it in dry-run and watch:

      systemctl start ${APP_NAME}
      journalctl -u ${APP_NAME} -f
      tail -f ${APP_DIR}/logs/bot-\$(date +%F).log | jq .

 6. After 24-48 hours of dry-run logs, review what it WOULD have bought:

      cd ${APP_DIR} && sudo -u ${APP_USER} env PATH="${NODE_BIN_DIR}:\$PATH" npm run status

 Only then consider setting DRY_RUN=false.
================================================================================

EOF
