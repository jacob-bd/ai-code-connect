# AI Code Connect (aic)

A lightweight CLI tool that connects Claude Code and Gemini CLI, eliminating the need to manually copy-paste proposals and feedback between AI coding assistants.

## Problem

When working with multiple AI coding tools, you often:
1. Ask Gemini CLI for a proposal
2. Copy the response
3. Paste it into Claude Code for review
4. Copy Claude's feedback
5. Paste it back to Gemini
6. Repeat...

This is tedious and error-prone.

## Solution

`aic` (AI Code Connect) bridges both tools, letting you:
- Send prompts to either tool with a simple command
- Forward responses between tools with one command
- Keep track of the conversation across both tools
- Run an interactive session that handles everything

## Installation

```bash
# Clone the repository
cd claude-gemini-cli

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Prerequisites

You need both AI CLI tools installed:

- **Claude Code**: Install via `npm install -g @anthropic-ai/claude-code` or see [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
- **Gemini CLI**: Install via `npm install -g @google/gemini-cli` or see [Gemini CLI docs](https://developers.google.com/gemini-code-assist/docs/gemini-cli)

Verify installation:
```bash
aic tools
# Should show both tools as "✓ available"
```

## Usage

### One-shot commands

Send a prompt to a specific tool:

```bash
# Ask Claude
aic ask claude "How should I refactor this authentication module?"

# Ask Gemini
aic ask gemini "Propose a plan for implementing user sessions"
```

### Forward responses between tools

After getting a response, forward it to the other tool for review:

```bash
# First, ask Gemini for a proposal
aic ask gemini "How should I structure this React component?"

# Then forward Gemini's response to Claude for review
aic forward gemini claude

# Optionally add context
aic forward gemini claude -m "Focus on performance implications"
```

### Interactive session

For back-and-forth conversations, start an interactive session:

```bash
aic start
```

In the interactive session:
- `@claude <message>` - Send to Claude Code
- `@gemini <message>` - Send to Gemini CLI
- `/forward @<tool> [message]` - Forward last response to another tool
- `/use <tool>` - Set default tool
- `/history` - Show conversation history
- `/clear` - Clear session
- `/quit` or `/exit` - Exit

Example session:
```
[claude] > @gemini How should I implement caching for this API?
Sending to gemini...
────────────────────────────────────────────────────────────────
[Gemini CLI]
────────────────────────────────────────────────────────────────
I suggest implementing a Redis-based caching layer with...
────────────────────────────────────────────────────────────────

[claude] > /forward @claude What do you think of this approach?
Forwarding to claude...
────────────────────────────────────────────────────────────────
[Claude Code]
────────────────────────────────────────────────────────────────
The Redis approach is solid, but I'd also consider...
────────────────────────────────────────────────────────────────
```

### Other commands

```bash
# Show conversation history
aic history

# List available tools
aic tools

# Clear session
aic clear

# Show help
aic --help
```

## Configuration

Configuration is stored in `~/.aic/config.json`:

```json
{
  "defaultTool": "claude",
  "tools": {
    "claude": {
      "command": "claude",
      "defaultFlags": ["-p", "--output-format", "text"]
    },
    "gemini": {
      "command": "gemini",
      "defaultFlags": ["-o", "text"]
    }
  }
}
```

## How It Works

1. **Tool Adapters**: Each AI tool has an adapter that knows how to:
   - Check if the tool is installed
   - Send prompts in non-interactive mode
   - Parse and clean the response

2. **Session Manager**: Tracks conversation history across tools and enables forwarding.

3. **Forwarding**: When you forward a response, the bridge:
   - Takes the last response from the source tool
   - Wraps it with context (e.g., "Another AI assistant proposed...")
   - Sends it to the target tool for review

## Adding New Tools

The architecture is pluggable. To add a new tool (e.g., Codex CLI):

1. Create `src/adapters/codex.ts` implementing the `ToolAdapter` interface
2. Register it in `src/index.ts`
3. Rebuild with `npm run build`

Example adapter:

```typescript
import { ToolAdapter, SendOptions } from './base.js';
import { runCommand, commandExists, stripAnsi } from '../utils.js';

export class CodexAdapter implements ToolAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  
  async isAvailable(): Promise<boolean> {
    return commandExists('codex');
  }
  
  getCommand(prompt: string, options?: SendOptions): string[] {
    return ['codex', '--non-interactive', prompt];
  }
  
  async send(prompt: string, options?: SendOptions): Promise<string> {
    const args = this.getCommand(prompt, options).slice(1);
    const result = await runCommand('codex', args, {
      cwd: options?.cwd || process.cwd(),
    });
    return stripAnsi(result.stdout).trim();
  }
}
```

## Development

```bash
# Run in development mode (no build needed)
npm run dev -- ask claude "test"

# Build
npm run build

# Run built version
npm start -- ask claude "test"
```

## License

MIT
