#!/bin/bash
# Claude Kiugi (macOS) - start server (skip if running) and open browser. Terminal window version of Launch.app
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
node app/launch.mjs || { echo "Failed to start - see data/server.log"; read -n 1 -s; }
