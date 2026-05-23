#!/bin/bash

# PeerMesh Agent Installer for Mac/Linux
# Double-click or run: bash install-mac.sh

clear
echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║          PEERMESH AGENT SETUP             ║"
echo "  ║  Share your connection. Stay free.        ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

AGENT_DIR="$HOME/peermesh-agent"
AGENT_URL="https://peermesh-0unl.onrender.com/api/agent-download"

# Step 1: Check Node.js
echo "  [1/3] Checking for Node.js..."

if ! command -v node &> /dev/null; then
    echo "  Node.js not found. Installing..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            brew install node@20 --quiet
        else
            # Download and install Node.js directly
            NODE_PKG="node-v20.11.0.pkg"
            echo "  Downloading Node.js..."
            curl -L "https://nodejs.org/dist/v20.11.0/$NODE_PKG" -o "/tmp/$NODE_PKG" --silent --show-error
            sudo installer -pkg "/tmp/$NODE_PKG" -target / > /dev/null 2>&1
            rm "/tmp/$NODE_PKG"
            export PATH="/usr/local/bin:$PATH"
        fi
    else
        # Linux
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
        sudo apt-get install -y nodejs > /dev/null 2>&1
    fi
    
    if ! command -v node &> /dev/null; then
        echo ""
        echo "  ERROR: Could not install Node.js automatically."
        echo "  Please install from https://nodejs.org then run this script again."
        exit 1
    fi
fi

NODE_VERSION=$(node --version)
echo "  ✓ Node.js $NODE_VERSION"

# Step 2: Download agent
echo ""
echo "  [2/3] Downloading PeerMesh agent..."
mkdir -p "$AGENT_DIR"

if command -v curl &> /dev/null; then
    curl -L "$AGENT_URL" -o "$AGENT_DIR/peermesh-agent.js" --silent --show-error
else
    wget -q "$AGENT_URL" -O "$AGENT_DIR/peermesh-agent.js"
fi

if [ ! -f "$AGENT_DIR/peermesh-agent.js" ]; then
    echo "  ERROR: Could not download agent. Check your connection."
    exit 1
fi

echo "  ✓ Agent downloaded"

# Step 3: Install dependencies
echo ""
echo "  [3/3] Installing dependencies..."
cd "$AGENT_DIR"
npm install ws --save > /dev/null 2>&1
echo "  ✓ Dependencies installed"

# Make it easy to run again
echo "node $AGENT_DIR/peermesh-agent.js" > "$AGENT_DIR/start.sh"
chmod +x "$AGENT_DIR/start.sh"

echo ""
echo "  ════════════════════════════════════════════"
echo "   ✓ Setup complete! Starting agent..."
echo "  ════════════════════════════════════════════"
echo ""
echo "  The agent is running. Go back to your"
echo "  browser — the toggle activates automatically."
echo ""
echo "  To stop: press Ctrl+C"
echo "  To restart later: run ~/peermesh-agent/start.sh"
echo "  ════════════════════════════════════════════"
echo ""

# Run the agent
node "$AGENT_DIR/peermesh-agent.js"
