#!/bin/bash

###############################################################################
# Cursor-To-OpenAI -> OpenClaw Automated Setup Script
# 
# Run this script DIRECTLY on your droplet after SSHing in.
# 
# One-liner to download and run:
#   curl -fsSL https://raw.githubusercontent.com/pwnapplehat/cursor-proxy-patched/master/setup-openclaw-cursor.sh | bash
# 
# Or clone and run:
#   git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
#   cd cursor-proxy-patched
#   bash setup-openclaw-cursor.sh
#
# This script automates:
# - Deploys Cursor proxy on your droplet
# - Configures OpenClaw with Cursor models
# - Pairs gateway device
# - Applies all required patches (context management, ripgrep, swap, etc.)
#
# Prerequisites:
# - Docker and OpenClaw container already running on this server
# - Cursor cookie obtained (see instructions below)
###############################################################################

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Progress indicator
step_num=0
total_steps=13

SEP="--------------------------------------------------------------------------------"
print_header() {
    echo -e "\n${CYAN}${SEP}${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}${SEP}${NC}\n"
}

print_step() {
    step_num=$((step_num + 1))
    echo -e "\n${BLUE}[Step $step_num/$total_steps]${NC} ${GREEN}$1${NC}"
}

print_info() {
    echo -e "${CYAN}(i)${NC} $1"
}

print_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!] ${NC} $1"
}

print_error() {
    echo -e "${RED}[X]${NC} $1"
}

print_manual_action() {
    echo -e "\n${YELLOW}${SEP}${NC}"
    echo -e "${YELLOW}  [!] MANUAL ACTION REQUIRED${NC}"
    echo -e "${YELLOW}${SEP}${NC}"
    echo -e "$1"
    echo -e "${YELLOW}${SEP}${NC}\n"
}

# Banner
clear
print_header "Cursor-To-OpenAI -> OpenClaw Automated Setup"
echo -e "${CYAN}This script will set up the complete Cursor proxy + OpenClaw integration.${NC}"
echo -e "${CYAN}Running on: $(hostname)${NC}\n"

###############################################################################
# STEP 0: Manual cookie acquisition instructions
###############################################################################

print_manual_action "Before we begin, you need to obtain your Cursor cookie.

${YELLOW}On your Windows PC, run these commands in PowerShell:${NC}

    cd ~
    git clone https://github.com/JiuZ-Chn/Cursor-To-OpenAI.git
    cd Cursor-To-OpenAI
    npm install
    npm run login

1. Open the printed URL in your browser
2. Log in with your Cursor account
3. Copy the cookie string (starts with 'WorkosCursorSessionToken=...')

${GREEN}Press Enter when you have your cookie ready...${NC}"

read -r

###############################################################################
# Get Cursor cookie
###############################################################################

print_header "Configuration Input"

echo -n "Paste your Cursor cookie: "
read -r CURSOR_COOKIE
if [[ -z "$CURSOR_COOKIE" ]]; then
    print_error "Cookie cannot be empty"
    exit 1
fi
# Trim whitespace
CURSOR_COOKIE=$(echo "$CURSOR_COOKIE" | xargs)
print_success "Cookie received (${#CURSOR_COOKIE} characters)"

# Optional: Telegram owner ID for cron/gateway tools
echo ""
echo -n "Telegram user ID for owner access (cron, gateway tools)? Get it via /whoami in chat. Press Enter to skip: "
read -r TELEGRAM_OWNER_ID
TELEGRAM_OWNER_ID=$(echo "$TELEGRAM_OWNER_ID" | tr -cd '0-9')

# Confirm before proceeding
echo -e "\n${YELLOW}Ready to begin setup?${NC}"
echo "  Cookie length: ${#CURSOR_COOKIE} characters"
echo "  Server: $(hostname)"
[[ -n "$TELEGRAM_OWNER_ID" ]] && echo "  Telegram owner: $TELEGRAM_OWNER_ID"
echo ""
echo -n "Proceed with setup? (yes/no): "
read -r CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy][Ee]?[Ss]?$ ]]; then
    print_warning "Setup cancelled by user"
    exit 0
fi

###############################################################################
# Check prerequisites
###############################################################################

print_step "Checking prerequisites"

# Check Docker
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi
print_success "Docker is installed"

# Check if OpenClaw container exists
if ! docker ps -a --format '{{.Names}}' | grep -q '^openclaw$'; then
    print_error "OpenClaw container not found. Please deploy OpenClaw first."
    exit 1
fi
print_success "OpenClaw container found"

# Check if OpenClaw is running
if ! docker ps --format '{{.Names}}' | grep -q '^openclaw$'; then
    print_warning "OpenClaw container is stopped. Starting it..."
    docker start openclaw
    sleep 5
fi
print_success "OpenClaw container is running"

###############################################################################
# Install git if needed
###############################################################################

print_step "Installing git"
apt-get update -qq
apt-get install -y -qq git > /dev/null 2>&1
print_success "Git installed"

###############################################################################
# Clone patched proxy repo
###############################################################################

print_step "Cloning Cursor proxy (patched fork)"
cd /opt
if [ -d "cursor-proxy-patched" ]; then
    print_warning "Repo already exists, pulling latest..."
    cd cursor-proxy-patched && git pull origin master
else
    git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
fi
print_success "Proxy repo ready"

###############################################################################
# Copy patched files to host
###############################################################################

print_step "Copying patched files"
cp /opt/cursor-proxy-patched/src/app.js /opt/cursor-proxy-app.js
cp /opt/cursor-proxy-patched/src/utils/utils.js /opt/cursor-proxy-utils.js
cp /opt/cursor-proxy-patched/src/routes/v1.js /opt/cursor-proxy-v1.js
cp /opt/cursor-proxy-patched/src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
cp /opt/cursor-proxy-patched/src/proto/message.js /opt/cursor-proxy-message.js
cp /opt/cursor-proxy-patched/src/utils/h2-bidi.js /opt/cursor-proxy-h2-bidi.js
print_success "6 patched files copied"

###############################################################################
# Stop existing proxy if running
###############################################################################

if docker ps -a --format '{{.Names}}' | grep -q '^cursor-proxy$'; then
    print_warning "Removing existing cursor-proxy container..."
    docker stop cursor-proxy 2>/dev/null || true
    docker rm cursor-proxy 2>/dev/null || true
fi

###############################################################################
# Deploy proxy container
###############################################################################

print_step "Deploying Cursor proxy container"
docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-app.js:/app/src/app.js:ro \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  -v /opt/cursor-proxy-message.js:/app/src/proto/message.js:ro \
  -v /opt/cursor-proxy-h2-bidi.js:/app/src/utils/h2-bidi.js:ro \
  ghcr.io/jiuz-chn/cursor-to-openai:latest

sleep 5
print_success "Proxy container deployed"

# Verify proxy is running
if docker logs cursor-proxy 2>&1 | grep -q "The server listens port: 3010"; then
    print_success "Proxy is listening on port 3010"
else
    print_warning "Proxy may not have started correctly. Logs:"
    docker logs cursor-proxy --tail 10
fi

###############################################################################
# Configure OpenClaw with Cursor models
###############################################################################

print_step "Configuring OpenClaw with Cursor models"

docker exec openclaw bash -c 'cat > /home/node/.openclaw/openclaw.json << '\''OCEOF'\''
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cursor/claude-4.5-sonnet-thinking",
        "fallbacks": [
          "cursor/gpt-4o"
        ]
      },
      "models": {
        "cursor/claude-4.5-sonnet-thinking": {
          "alias": "Sonnet 4.5 Thinking"
        },
        "cursor/gpt-4o": {
          "alias": "GPT-4o"
        }
      },
      "workspace": "~/.openclaw/workspace",
      "memorySearch": {
        "provider": "openai",
        "model": "text-embedding-3-small"
      },
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "text_end",
      "contextTokens": 200000,
      "timeoutSeconds": 86400,
      "compaction": {
        "mode": "safeguard",
        "maxHistoryShare": 0.6,
        "reserveTokensFloor": 20000
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m",
        "keepLastAssistants": 5,
        "softTrimRatio": 0.4,
        "hardClearRatio": 0.6,
        "minPrunableToolChars": 30000,
        "softTrim": {
          "maxChars": 6000,
          "headChars": 2500,
          "tailChars": 2500
        },
        "hardClear": {
          "enabled": true,
          "placeholder": "[Earlier tool result cleared to manage context. Key findings preserved in conversation history.]"
        }
      }
    },
    "list": [
      {
        "id": "main"
      }
    ]
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cursor": {
        "baseUrl": "http://127.0.0.1:3010/v1",
        "apiKey": "CURSOR_COOKIE_PLACEHOLDER",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-4.5-sonnet-thinking",
            "name": "Claude 4.5 Sonnet (Thinking)",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "blockStreaming": true,
      "streamMode": "off",
      "dmHistoryLimit": 100
    }
  },
  "gateway": {
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "mode": "token"
    },
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  },
  "tools": {
    "deny": ["process"],
    "exec": {
      "timeoutSec": 7200
    }
  }
}
OCEOF
'

# Get public IP for Control UI allowedOrigins (OpenClaw 2026.2.21+)
PUBLIC_IP=$(curl -sf --connect-timeout 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || curl -sf --connect-timeout 3 https://ifconfig.me/ip 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
if [ -z "$PUBLIC_IP" ]; then
    print_warning "Could not detect public IP - Control UI may show 'origin not allowed'. Add gateway.controlUi.allowedOrigins manually."
fi

# Now inject the actual cookie, optional Telegram owner, and allowedOrigins
docker exec -u root openclaw bash -c "
python3 -c \"
import json, re
cfg = json.load(open('/home/node/.openclaw/openclaw.json'))
cfg['models']['providers']['cursor']['apiKey'] = '${CURSOR_COOKIE}'
if '${TELEGRAM_OWNER_ID}':
    if 'commands' not in cfg:
        cfg['commands'] = {}
    cfg['commands']['ownerAllowFrom'] = ['telegram:${TELEGRAM_OWNER_ID}']
    print('Telegram owner added for cron/gateway tools')
# OpenClaw 2026.2.21+ fix: explicit allowedOrigins for Control UI (validate IP to prevent injection)
ip = '${PUBLIC_IP}'.strip()
if ip and re.match(r'^([0-9]{1,3}\\.){3}[0-9]{1,3}$', ip):
    ctrl = cfg.setdefault('gateway', {}).setdefault('controlUi', {})
    ctrl['allowedOrigins'] = [f'https://{ip}', f'https://{ip}:443', f'http://{ip}', f'http://{ip}:80']
    print('Control UI allowedOrigins set for', ip)
json.dump(cfg, open('/home/node/.openclaw/openclaw.json', 'w'), indent=2)
print('Cookie injected into config')
\"
chown node:node /home/node/.openclaw/openclaw.json
"

print_success "OpenClaw config written with Cursor cookie"

###############################################################################
# Restart OpenClaw
###############################################################################

print_step "Restarting OpenClaw"
docker restart openclaw
sleep 10
print_success "OpenClaw restarted"

# Verify OpenClaw picked up the config
if docker logs openclaw 2>&1 | grep -q "cursor/claude-4.5-sonnet-thinking"; then
    print_success "OpenClaw loaded Cursor models"
else
    print_warning "Checking OpenClaw logs:"
    docker logs openclaw --tail 10
fi

###############################################################################
# Pair gateway device (required for sessions_spawn / sub-agent spawning)
###############################################################################
# Recent OpenClaw (2026.2.19+) requires device pairing for ALL gateway connections,
# including embedded agent -> gateway calls used by sessions_spawn. Without pairing,
# sub-agent spawn fails with "pairing required". We pair each instance so the
# embedded agent (same process as gateway) can call gateway RPCs for spawn.
###############################################################################

pair_container() {
  local CONTAINER=$1
  print_info "Pairing device for $CONTAINER..."

  # Trigger pairing request (devices list connects and creates pending if not paired)
  docker exec "$CONTAINER" npx openclaw devices list 2>/dev/null || true
  sleep 3

  # Try openclaw devices approve (OpenClaw 2026.2.15+)
  if docker exec "$CONTAINER" npx openclaw devices approve 2>/dev/null; then
    print_success "Pairing approved via CLI for $CONTAINER"
    return 0
  fi

  # Fallback: approve manually via Node (for older OpenClaw or when approve fails)

  docker exec "$CONTAINER" node -e '
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const stateDir = process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw";
const devicesDir = path.join(stateDir, "devices");
const pendingPath = path.join(devicesDir, "pending.json");
const pairedPath = path.join(devicesDir, "paired.json");

const ADMIN_SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];

function loadJson(p, def) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return raw.trim() ? JSON.parse(raw) : def;
  } catch {
    return def;
  }
}

try {
  const pending = loadJson(pendingPath, {});
  let paired = loadJson(pairedPath, {});
  const requestIds = Object.keys(pending);
  const requestId = requestIds[0];
  const req = requestId ? pending[requestId] : null;

  if (!req) {
    console.log("No pending request - device may already be paired.");
    process.exit(0);
  }

  const scopes = Array.isArray(req.scopes) && req.scopes.length > 0
    ? req.scopes
    : ADMIN_SCOPES;
  const role = req.role || "operator";
  const now = Date.now();
  const token = crypto.randomBytes(32).toString("base64url");

  paired[req.deviceId] = {
    deviceId: req.deviceId,
    publicKey: req.publicKey,
    platform: req.platform || "node",
    clientId: req.clientId,
    clientMode: req.clientMode,
    role,
    roles: req.roles || [role],
    scopes,
    approvedScopes: scopes,
    remoteIp: req.remoteIp,
    tokens: {
      [role]: {
        token,
        role,
        scopes,
        createdAtMs: now
      }
    },
    createdAtMs: now,
    approvedAtMs: now
  };

  delete pending[requestId];
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(pairedPath, JSON.stringify(paired, null, 2));
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  console.log("Device approved:", req.deviceId.substring(0, 16) + "...");
} catch (e) {
  console.error("Pairing error:", e.message);
  process.exit(1);
}
' 2>/dev/null

  if [ $? -eq 0 ]; then
    print_success "Device paired for $CONTAINER"
  else
    print_warning "Pairing may have failed for $CONTAINER"
  fi
}

print_step "Pairing gateway device(s) for sessions_spawn"

# Pair primary container
pair_container openclaw

# Restart primary after pairing
print_info "Restarting OpenClaw after pairing..."
docker restart openclaw
sleep 10

# Verify primary pairing
if docker exec openclaw npx openclaw devices list 2>&1 | grep -q "Paired"; then
  print_success "Gateway device successfully paired"
else
  print_warning "Pairing status unclear. Run: docker exec openclaw npx openclaw devices list"
  docker exec openclaw npx openclaw devices list 2>/dev/null || true
fi

###############################################################################
# Configure Fleet Instances (if any exist)
###############################################################################

print_step "Detecting and configuring fleet instances"

# Check if fleet config exists
if [ -f /opt/cloudclaw/fleet-config.json ]; then
    print_info "Fleet config found, checking for additional instances..."
    
    # Parse fleet config to get instance numbers
    FLEET_INSTANCES=$(python3 -c "
import json
try:
    with open('/opt/cloudclaw/fleet-config.json') as f:
        cfg = json.load(f)
        instances = cfg.get('instances', {})
        # Get all instance numbers except 1 (primary already configured)
        fleet_nums = [k for k in instances.keys() if k != '1']
        print(' '.join(fleet_nums))
except Exception:
    pass
" 2>/dev/null)
    
    if [ -n "$FLEET_INSTANCES" ]; then
        FLEET_COUNT=$(echo "$FLEET_INSTANCES" | wc -w)
        print_success "Found $FLEET_COUNT fleet instance(s): $FLEET_INSTANCES"
        
        for INST_NUM in $FLEET_INSTANCES; do
            print_info "Configuring instance $INST_NUM..."
            
            CONTAINER_NAME="openclaw-$INST_NUM"
            CONFIG_PATH="/opt/openclaw/instances/$INST_NUM/config/openclaw.json"
            
            # Check if container exists and is running
            if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME\$"; then
                print_warning "Container $CONTAINER_NAME not running, skipping"
                continue
            fi
            
            # Backup existing config
            if [ -f "$CONFIG_PATH" ]; then
                cp "$CONFIG_PATH" "${CONFIG_PATH}.backup-$(date +%s)" 2>/dev/null || true
            fi
            
            # Inject cursor provider config using Python
            docker exec -u root "$CONTAINER_NAME" bash -c "
python3 -c \"
import json
import os

config_path = '/home/node/.openclaw/openclaw.json'
try:
    with open(config_path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

# Ensure models structure exists
if 'models' not in cfg:
    cfg['models'] = {}
if 'providers' not in cfg['models']:
    cfg['models']['providers'] = {}

# Set mode to merge if not set
if 'mode' not in cfg['models']:
    cfg['models']['mode'] = 'merge'

# Add/update cursor provider
cfg['models']['providers']['cursor'] = {
    'baseUrl': 'http://127.0.0.1:3010/v1',
    'apiKey': '${CURSOR_COOKIE}',
    'api': 'openai-completions',
    'models': [
        {
            'id': 'claude-4.5-sonnet-thinking',
            'name': 'Claude 4.5 Sonnet (Thinking)',
            'reasoning': True,
            'input': ['text'],
            'contextWindow': 200000,
            'maxTokens': 8192
        },
        {
            'id': 'gpt-4o',
            'name': 'GPT-4o',
            'reasoning': False,
            'input': ['text'],
            'contextWindow': 128000,
            'maxTokens': 8192
        }
    ]
}

# Switch agent to use Cursor (fleet instances are created with openai/gpt-4.1)
if 'agents' not in cfg:
    cfg['agents'] = {}
if 'defaults' not in cfg['agents']:
    cfg['agents']['defaults'] = {}
if 'model' not in cfg['agents']['defaults']:
    cfg['agents']['defaults']['model'] = {}
cfg['agents']['defaults']['model']['primary'] = 'cursor/claude-4.5-sonnet-thinking'
cfg['agents']['defaults']['model']['fallbacks'] = ['cursor/gpt-4o']

# Add Telegram owner for cron/gateway tools (same as primary)
if '${TELEGRAM_OWNER_ID}':
    if 'commands' not in cfg:
        cfg['commands'] = {}
    cfg['commands']['ownerAllowFrom'] = ['telegram:${TELEGRAM_OWNER_ID}']

# Write config
with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)

print('Config updated for instance $INST_NUM')
\"
chown node:node /home/node/.openclaw/openclaw.json
" 2>/dev/null
            
            if [ $? -eq 0 ]; then
                print_success "Instance $INST_NUM config updated"
                
                # Pair device for sessions_spawn (each fleet instance has its own state dir)
                pair_container "$CONTAINER_NAME"
                
                # Restart the instance
                print_info "Restarting instance $INST_NUM..."
                docker restart "$CONTAINER_NAME" >/dev/null 2>&1
                sleep 5
                
                # Verify proxy reachability
                if docker exec "$CONTAINER_NAME" curl -sf -o /dev/null http://127.0.0.1:3010/v1/models 2>/dev/null; then
                    print_success "Instance $INST_NUM can reach cursor proxy"
                else
                    print_warning "Instance $INST_NUM proxy check failed (may need more time)"
                fi
            else
                print_error "Failed to update instance $INST_NUM config"
            fi
        done
        
        print_success "Fleet configuration complete"
    else
        print_info "No fleet instances found (primary only)"
    fi
else
    print_info "No fleet config found (primary instance only)"
fi

###############################################################################
# Apply context management patch to ALL instances
###############################################################################

print_step "Applying context management patch to all instances"

# Get list of all running openclaw containers
ALL_CONTAINERS=$(docker ps --format '{{.Names}}' | grep '^openclaw' || true)

if [ -z "$ALL_CONTAINERS" ]; then
    print_warning "No OpenClaw containers found"
else
    for CONTAINER in $ALL_CONTAINERS; do
        print_info "Patching $CONTAINER..."
        
        docker exec "$CONTAINER" node << 'PATCH_EOF' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const distDir = '/app/dist';
try {
  const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
  let patchCount = 0;
  for (const fname of files) {
    const file = path.join(distDir, fname);
    let code;
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const marker = 'function isCacheTtlEligibleProvider';
    const fnIdx = code.indexOf(marker);
    if (fnIdx === -1) continue;
    const region = code.substring(fnIdx, fnIdx + 600);
    if (region.includes('"cursor"')) {
      patchCount++;
      continue;
    }
    const rfIdx = region.lastIndexOf('return false');
    if (rfIdx === -1) continue;
    const globalIdx = fnIdx + rfIdx;
    const cursorCheck = 'if (normalizedProvider === "cursor") {\n    return true;\n  }\n  ';
    code = code.substring(0, globalIdx) + cursorCheck + code.substring(globalIdx);
    fs.writeFileSync(file, code);
    patchCount++;
  }
  if (patchCount > 0) {
    console.log('Patched ' + patchCount + ' file(s)');
  }
} catch (e) {
  console.error('Patch error:', e.message);
}
PATCH_EOF
        
        if [ $? -eq 0 ]; then
            print_success "$CONTAINER patched"
        else
            print_warning "$CONTAINER patch may have failed"
        fi
    done
fi

###############################################################################
# Legacy: Apply context management patch to primary (kept for compatibility)
###############################################################################

print_step "Applying context management patch to OpenClaw bundle (legacy)"

docker exec openclaw node << 'PATCH_EOF'
const fs = require('fs');
const path = require('path');
const distDir = '/app/dist';
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
let patchCount = 0;
for (const fname of files) {
  const file = path.join(distDir, fname);
  let code;
  try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const marker = 'function isCacheTtlEligibleProvider';
  const fnIdx = code.indexOf(marker);
  if (fnIdx === -1) continue;
  const region = code.substring(fnIdx, fnIdx + 600);
  if (region.includes('"cursor"')) {
    console.log('Already patched: ' + fname);
    patchCount++;
    continue;
  }
  const rfIdx = region.lastIndexOf('return false');
  if (rfIdx === -1) {
    console.error('return false not found in ' + fname);
    continue;
  }
  const globalIdx = fnIdx + rfIdx;
  const cursorCheck = 'if (normalizedProvider === "cursor") {\n    return true;\n  }\n  ';
  code = code.substring(0, globalIdx) + cursorCheck + code.substring(globalIdx);
  fs.writeFileSync(file, code);
  console.log('Patched: ' + fname);
  patchCount++;
}
if (patchCount === 0) {
  console.error('ERROR: No files patched');
  process.exit(1);
} else {
  console.log('Done - patched ' + patchCount + ' file(s)');
}
PATCH_EOF

print_success "Context management patch applied"

###############################################################################
# Install ripgrep
###############################################################################

print_step "Installing ripgrep in OpenClaw container"
docker exec -u root openclaw bash -c 'apt-get update -qq && apt-get install -y -qq ripgrep' > /dev/null 2>&1
print_success "Ripgrep installed"

# Verify
if docker exec openclaw rg --version > /dev/null 2>&1; then
    print_success "Ripgrep is working"
else
    print_warning "Ripgrep installation may have failed"
fi

###############################################################################
# Add swap space (prevents OOM kills)
###############################################################################

print_step "Checking swap space"
if swapon --show | grep -q '/swapfile'; then
    print_success "Swap already configured"
else
    print_info "Creating 4GB swap file..."
    if [ ! -f /swapfile ]; then
        fallocate -l 4G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile > /dev/null 2>&1
        swapon /swapfile
        if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' >> /etc/fstab
        fi
        print_success "Swap space created (4GB)"
    fi
fi

###############################################################################
# Final restart
###############################################################################

print_step "Final restart of OpenClaw"
docker restart openclaw
sleep 10
print_success "OpenClaw restarted"

###############################################################################
# Verification
###############################################################################

print_step "Running verification checks"

# Check proxy
if docker ps | grep -q cursor-proxy; then
    print_success "[OK] Proxy container running"
else
    print_error "[X] Proxy container not running"
fi

# Check OpenClaw
if docker ps | grep -q openclaw; then
    print_success "[OK] OpenClaw container running"
else
    print_error "[X] OpenClaw container not running"
fi

# Check proxy is reachable from OpenClaw
if docker exec openclaw curl -s http://127.0.0.1:3010/v1/models | grep -q "claude"; then
    print_success "[OK] Proxy is reachable from OpenClaw"
else
    print_warning "[!] Proxy may not be reachable"
fi

# Check config has cursor provider
if docker exec openclaw cat /home/node/.openclaw/openclaw.json | grep -q '"cursor"'; then
    print_success "[OK] Cursor provider configured"
else
    print_error "[X] Cursor provider not found in config"
fi

# Check config has cursor provider in fleet instances
if [ -f /opt/cloudclaw/fleet-config.json ]; then
    FLEET_INSTANCES=$(python3 -c "
import json
try:
    with open('/opt/cloudclaw/fleet-config.json') as f:
        cfg = json.load(f)
        instances = cfg.get('instances', {})
        fleet_nums = [k for k in instances.keys() if k != '1']
        print(' '.join(fleet_nums))
except Exception:
    pass
" 2>/dev/null)
    
    if [ -n "$FLEET_INSTANCES" ]; then
        for INST_NUM in $FLEET_INSTANCES; do
            CONTAINER_NAME="openclaw-$INST_NUM"
            if docker ps | grep -q "^$CONTAINER_NAME$"; then
                if docker exec "$CONTAINER_NAME" cat /home/node/.openclaw/openclaw.json 2>/dev/null | grep -q '"cursor"'; then
                    print_success "Fleet instance $INST_NUM configured"
                else
                    print_warning "Fleet instance $INST_NUM config check failed"
                fi
            fi
        done
    fi
fi
# Check ripgrep
if docker exec openclaw which rg > /dev/null 2>&1; then
    print_success "[OK] Ripgrep installed"
else
    print_warning "[!] Ripgrep not found"
fi

# Check swap
if swapon --show | grep -q '/swapfile'; then
    print_success "[OK] Swap space active"
else
    print_warning "[!] Swap not configured"
fi

echo ""
print_success "All automated setup steps completed!"

###############################################################################
# Show logs
###############################################################################

echo -e "\n${CYAN}${SEP}${NC}"
echo -e "${CYAN}  Proxy logs (last 5 lines):${NC}"
echo -e "${CYAN}${SEP}${NC}"
docker logs cursor-proxy --tail 5

echo -e "\n${CYAN}${SEP}${NC}"
echo -e "${CYAN}  OpenClaw logs (last 5 lines):${NC}"
echo -e "${CYAN}${SEP}${NC}"
docker logs openclaw --tail 5

###############################################################################
# Manual testing instructions
###############################################################################

print_manual_action "Setup is complete! Now test the integration:

${GREEN}1. Send a message to your OpenClaw agent via Telegram${NC}
   Example: 'Hello! Can you check your available models?'

${GREEN}2. Monitor the proxy logs:${NC}
   docker logs cursor-proxy -f --tail 20

   Look for:
   - POST /v1/chat/completions 200
   - [convertNativeToolCall] run_terminal_cmd -> exec
   - [streaming] Emitting tool calls

${GREEN}3. Test sub-agent spawning:${NC}
   In Telegram: 'spawn a test sub-agent that says hello'
   
   Proxy logs should show:
   [expandOcExecCalls] __oc sessions_spawn -> sessions_spawn

${GREEN}4. Test memory search:${NC}
   In Telegram: 'search your memory for my preferences'
   
   Proxy logs should show:
   [expandOcExecCalls] __oc memory_search -> memory_search

${CYAN}${SEP}${NC}
${CYAN}Useful Commands:${NC}
${CYAN}${SEP}${NC}

# Watch proxy logs in real-time:
docker logs cursor-proxy -f --tail 20

# Watch OpenClaw logs:
docker logs openclaw -f --tail 20

# Check device pairing status:
docker exec openclaw npx openclaw devices list

# Check OpenClaw config:
docker exec openclaw cat /home/node/.openclaw/openclaw.json

# Restart services:
docker restart cursor-proxy openclaw

# Update proxy when new patches are released:
cd /opt/cursor-proxy-patched && git pull origin master
cp src/*.js /opt/ && docker restart cursor-proxy

${CYAN}${SEP}${NC}

${GREEN}If everything works, you're done! ${NC}

If you encounter issues, check:
- Proxy logs: docker logs cursor-proxy --tail 30
- OpenClaw logs: docker logs openclaw --tail 30
- See troubleshooting section in the setup guide"

print_header "Setup Complete!"
echo -e "${GREEN}The Cursor-To-OpenAI -> OpenClaw integration is ready.${NC}"
echo -e "${GREEN}Default model: Claude 4.5 Sonnet (Thinking)${NC}\n"
