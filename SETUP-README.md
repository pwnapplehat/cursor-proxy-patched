# Automated Setup Script for Cursor-To-OpenAI → OpenClaw

This script automates the complete setup of the Cursor proxy and OpenClaw integration.

## Prerequisites

- Docker and OpenClaw container already running on your server
- SSH access to your droplet
- Cursor cookie (see below)

## Quick Start

### Step 1: Get Your Cursor Cookie (on your local PC)

```powershell
cd ~
git clone https://github.com/JiuZ-Chn/Cursor-To-OpenAI.git
cd Cursor-To-OpenAI
npm install
npm run login
```

Open the URL in your browser, log in, and copy the cookie string.

### Step 2: Run the Automated Setup (on your droplet)

SSH into your droplet and run:

```bash
curl -fsSL https://raw.githubusercontent.com/pwnapplehat/cursor-proxy-patched/master/setup-openclaw-cursor.sh | bash
```

Or download and run manually:

```bash
wget https://raw.githubusercontent.com/pwnapplehat/cursor-proxy-patched/master/setup-openclaw-cursor.sh
chmod +x setup-openclaw-cursor.sh
./setup-openclaw-cursor.sh
```

Or clone the repo first:

```bash
git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
cd cursor-proxy-patched
bash setup-openclaw-cursor.sh
```

### Step 3: Follow the Prompts

The script will:
1. Ask you to paste your Cursor cookie
2. Confirm you want to proceed
3. Automatically install and configure everything (takes 2-3 minutes)

## What Gets Installed

✅ **Cursor Proxy** (patched version with all 6 files)  
✅ **OpenClaw Configuration** (Claude 4.5 Sonnet Thinking as default model)  
✅ **Gateway Device Pairing** (for sub-agents, sessions, etc.)  
✅ **Context Management Patch** (prevents context overflow errors)  
✅ **Ripgrep** (for fast code searches)  
✅ **4GB Swap Space** (prevents OOM kills)  
✅ **All Optimizations** (24h timeout, no auto-backgrounding, etc.)

## Default Model

The script configures **Claude 4.5 Sonnet (Thinking)** as the primary model with GPT-4o as fallback.

## Testing

After setup completes, test by sending a message to your OpenClaw agent via Telegram:

```
Hello! Can you check your available models?
```

Monitor the proxy logs:

```bash
docker logs cursor-proxy -f --tail 20
```

## Useful Commands

```bash
# Watch proxy logs
docker logs cursor-proxy -f --tail 20

# Watch OpenClaw logs
docker logs openclaw -f --tail 20

# Check device pairing
docker exec openclaw npx openclaw devices list

# Restart services
docker restart cursor-proxy openclaw

# Update proxy to latest version
cd /opt/cursor-proxy-patched && git pull origin master
cp src/*.js /opt/ && docker restart cursor-proxy
```

## Troubleshooting

Check logs if something goes wrong:

```bash
docker logs cursor-proxy --tail 30
docker logs openclaw --tail 30
```

## What's Different from Manual Setup

This automated script:
- Runs entirely on the droplet (no SSH from local machine)
- Can be executed as a one-liner with curl
- Includes all patches and optimizations from the manual guide
- Uses Claude 4.5 Sonnet (Thinking) instead of Opus
- Provides progress indicators and colored output
- Verifies each step before proceeding

## Security Note

The cookie is only stored in the OpenClaw config file inside the container. It's never sent anywhere except to Cursor's API.
