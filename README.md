# AIC² - AI Code Connect

```
     █████╗ ██╗ ██████╗  ^2
    ██╔══██╗██║██╔════╝
    ███████║██║██║     
    ██╔══██║██║██║     
    ██║  ██║██║╚██████╗
    ╚═╝  ╚═╝╚═╝ ╚═════╝
```

A CLI tool that connects **Claude Code** and **Gemini CLI**, eliminating manual copy-paste between AI coding assistants.

**AIC²** = **A**I **C**ode **C**onnect (the two C's = ²)

## The Problem

When working with multiple AI coding tools:
1. Ask Gemini for a proposal
2. Copy the response
3. Paste into Claude for review
4. Copy Claude's feedback
5. Paste back to Gemini...

This is tedious and breaks your flow.

## The Solution

`aic` bridges both tools in a single interactive session with:
- **Persistent sessions** - Both tools remember context
- **One-command forwarding** - Send responses between tools instantly
- **Interactive mode** - Full access to slash commands and approvals
- **Detach/reattach** - Keep tools running in background

## Installation

```bash
# Clone and install
cd claude-gemini-cli
npm install
npm run build

# Link globally
npm link
```

## Prerequisites

Install both AI CLI tools:

- **Claude Code**: `npm install -g @anthropic-ai/claude-code`
- **Gemini CLI**: `npm install -g @google/gemini-cli`

Verify:
```bash
aic tools
# Should show both as "✓ available"
```

## Quick Start

```bash
aic
```

That's it! This launches the interactive session.

## Usage

### Basic Commands

| Command | Description |
|---------|-------------|
| `//claude` | Switch to Claude Code |
| `//gemini` | Switch to Gemini CLI |
| `//i` | Enter interactive mode (full tool access) |
| `//forward` | Forward last response to other tool (auto-selects if 2 tools) |
| `//forward [tool]` | Forward to specific tool (required if 3+ tools) |
| `//forward [tool] [msg]` | Forward with additional context |
| `//history` | Show conversation history |
| `//status` | Show running processes |
| `//clear` | Clear sessions and history |
| `//quit` or `//cya` | Exit |

### Command Menu

Type `/` or `//` to see a command menu. Use ↓ arrow to select, or keep typing.

### Example Session

```
❯ claude → How should I implement caching for this API?

⠹ Claude is thinking...
I suggest implementing a Redis-based caching layer...

❯ claude → //forward What do you think of this approach?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
↗ Forwarding from Claude Code → Gemini CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Gemini CLI responds:

The Redis approach is solid. I'd also consider...

❯ gemini → //claude
● Switched to Claude Code

❯ claude → Can you implement that?
```

### Interactive Mode

For full tool access (slash commands, approvals, etc.):

```bash
❯ claude → //i

▶ Starting Claude Code interactive mode...
Press Ctrl+] to detach • /exit to terminate

> /cost                    # Claude's slash command
> /config                  # Another slash command
> (press Ctrl+])           # Detach back to aic

⏸ Detached from Claude Code (still running)
Use //i to re-attach

❯ claude → //i             # Re-attach to same session
↩ Re-attaching to Claude Code...
```

**Key bindings in interactive mode:**
- `Ctrl+]` - Detach (tool keeps running)
- `/exit` - Terminate the tool session

> **Note:** Messages exchanged while in interactive mode (after `//i`) are not captured for forwarding. Use regular mode for conversations you want to forward between tools.

### Session Persistence

Sessions persist automatically:
- **Claude**: Uses `--continue` flag
- **Gemini**: Uses `--resume latest` flag

Your conversation context is maintained across messages.

## CLI Options

```bash
aic              # Launch interactive session (default)
aic tools        # List available AI tools
aic --version    # Show version
aic --help       # Show help
```

## Architecture

```
src/
├── adapters/
│   ├── base.ts           # ToolAdapter interface
│   ├── claude.ts         # Claude Code adapter
│   ├── gemini.ts         # Gemini CLI adapter
│   └── template.ts.example  # Template for new adapters
├── sdk-session.ts        # Interactive session logic
├── index.ts              # CLI entry point
└── utils.ts              # Utilities
```

## Adding New Tools

AIC² is modular. To add a new AI CLI (e.g., OpenAI Codex):

1. Copy the template: `cp src/adapters/template.ts.example src/adapters/codex.ts`
2. Implement the `ToolAdapter` interface
3. Register in `src/adapters/index.ts` and `src/index.ts`
4. Add to `src/sdk-session.ts`

See [ADDINGAI_CLIs.md](ADDINGAI_CLIs.md) for detailed instructions.

## Features

- ✅ **Colorful UI** - ASCII banner, colored prompts, status indicators
- ✅ **Spinner** - Visual feedback while waiting for responses
- ✅ **Session persistence** - Context maintained across messages
- ✅ **Interactive mode** - Full tool access with detach/reattach
- ✅ **Command menu** - Type `/` for autocomplete suggestions
- ✅ **Forward responses** - One command to send between tools
- ✅ **Modular adapters** - Easy to add new AI tools

## Development

```bash
# Development mode
npm run dev

# Build
npm run build

# Run
aic
```

## License

MIT
