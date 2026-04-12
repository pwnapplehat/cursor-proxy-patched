# OpenClaw + Patched Cursor Proxy (Manual Setup Guide)

This guide covers setting up OpenClaw to bypass OpenAI's official API and route all LLM traffic through a patched Cursor proxy, utilizing your Cursor Pro subscription (e.g., `gemini-3.1-pro`, `composer-2`).

## Prerequisites
1. **Node.js 24** installed on your server via `nvm`.
2. **Docker** installed on your server.
3. Your **Cursor Cookie** (obtained locally via `npm run login` in the Cursor-To-OpenAI repo).

---

## Step 1: Install OpenClaw
Connect to your server and install OpenClaw globally using npm.

```bash
# SSH into your server
ssh -i "path/to/key" root@YOUR_SERVER_IP

# Install OpenClaw
npm install -g openclaw@latest

# Run the onboarding wizard to set up workspace and Telegram
# (Make sure to export your Telegram Bot Token first)
export TELEGRAM_BOT_TOKEN='YOUR_BOT_TOKEN'
openclaw onboard --install-daemon
```

---

## Step 2: Set Up the Cursor Proxy Container
We need to clone the patched Cursor proxy repository, configure it with your cookie, and run it as a background Docker container.

```bash
# 1. Clone the patched repository
cd /opt
git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
cd cursor-proxy-patched

# 2. Create the Proxy Configuration File
cat > proxy-config.json << 'EOF'
{
  "model": "gemini-3.1-pro",
  "cookie": "YOUR_CURSOR_COOKIE_HERE"
}
EOF

# 3. Copy the patched utils.js (fixes context overflow & rate limits)
cp src/utils/utils.js /opt/utils.js

# 4. Build the Docker Image
docker build -t cursor-proxy .

# 5. Run the Proxy Container (Mapping internal port 3010 to external 5000)
docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 5000:3010 \
  -v /opt/utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-patched/proxy-config.json:/app/proxy-config.json:ro \
  cursor-proxy
```

*Verify the proxy is running correctly by checking the logs:*
```bash
docker logs cursor-proxy
# You should see: "The server listens port: 3010"
```

---

## Step 3: Patch the OpenClaw Configuration
Now we need to tell OpenClaw to completely ignore its default OpenAI provider and route everything to our local proxy running on port `5000`.

We will modify `~/.openclaw/openclaw.json` using a Python script to ensure we don't break the existing JSON structure.

```bash
# Run this entire block in your terminal
python3 << 'PYSCRIPT'
import json
import os

config_path = os.path.expanduser('~/.openclaw/openclaw.json')

with open(config_path, 'r') as f:
    config = json.load(f)

# 1. Define the custom Cursor provider pointing to our local proxy
if 'models' not in config:
    config['models'] = {}

config['models']['mode'] = 'merge'
if 'providers' not in config['models']:
    config['models']['providers'] = {}

config['models']['providers']['cursor'] = {
    'baseUrl': 'http://127.0.0.1:5000/v1',
    'apiKey': 'YOUR_CURSOR_COOKIE_HERE',
    'api': 'openai-completions',
    'models': [
        {
            'id': 'gemini-3.1-pro',
            'name': 'Gemini 3.1 Pro',
            'reasoning': True,
            'input': ['text'],
            'contextWindow': 200000,
            'maxTokens': 8192
        }
    ]
}

# 2. Register the alias in agent defaults
models = config.setdefault('agents', {}).setdefault('defaults', {}).setdefault('models', {})
models['cursor/gemini-3.1-pro'] = {
    'alias': 'Gemini 3.1 Pro'
}

# 3. Set the primary model to route through our new provider
config['agents']['defaults'].setdefault('model', {})['primary'] = 'cursor/gemini-3.1-pro'

# Save the patched configuration
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)

print('OpenClaw config successfully patched for Cursor proxy!')
PYSCRIPT
```

---

## Step 4: Run OpenClaw as a Systemd Service
To ensure OpenClaw runs 24/7 and restarts automatically on server reboots, we set it up as a `systemd` service.

```bash
# 1. Create the service file
cat > /etc/systemd/system/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway  
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
# Ensure NVM paths match your installation
Environment=NVM_DIR=/root/.nvm
Environment=PATH=/root/.nvm/versions/node/v24.14.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Optional fallback env vars (OpenClaw uses the JSON config, but these act as backups)
Environment=OPENAI_BASE_URL=http://127.0.0.1:5000/v1
Environment=OPENAI_API_KEY=dummy

ExecStart=/root/.nvm/versions/node/v24.14.1/bin/openclaw gateway --port 18789 --verbose
Restart=always
RestartSec=10

StandardOutput=append:/var/log/openclaw-gateway.log
StandardError=append:/var/log/openclaw-gateway.log

[Install]
WantedBy=multi-user.target
EOF

# 2. Reload daemon, enable, and start the service
systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl restart openclaw-gateway
```

---

## Step 5: Verification and Monitoring

Check that OpenClaw successfully booted using the new model:
```bash
grep 'agent model' /var/log/openclaw-gateway.log | tail -n 1
# Expected output: [gateway] agent model: cursor/gemini-3.1-pro
```

Monitor incoming traffic hitting the Cursor proxy when you send a Telegram message:
```bash
docker logs cursor-proxy -f
```

**Setup is complete!** All LLM traffic is now successfully isolated from OpenAI and routed exclusively through your authenticated Cursor proxy.