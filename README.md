# Clawdgotchi (agent-manager)

**English** | [한국어](README.ko.md)

A local dashboard that lets you **manage multiple Claude Code sessions (workers) from a single browser page** on your own PC.
Hand out tasks, watch their progress, and answer permission requests. Each worker is the same `claude` CLI you already use, so your slash commands, skills, MCP servers and settings all work as usual.

- A **local-only** tool that listens on `127.0.0.1` only (no outside communication, no remote access)
- Restarting the dashboard **does not disconnect workers** — they reattach automatically

## Requirements

- **Node.js 20 or later**
- **Claude Code CLI** — `claude` must run in your terminal and be logged in
- Windows 10/11 or macOS

## Installation

**Setting it up from Claude is recommended.**

```bash
git clone https://github.com/stzjinseong/agent-manager.git
```

Open `claude` in the cloned folder and run `/setup --mac` (on Windows, `/setup --windows`) — it checks everything and installs for you.
On macOS, if a security warning appears the first time you open `Launch.app`, **right-click → Open** it in Finder.
