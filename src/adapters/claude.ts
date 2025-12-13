import { randomUUID } from 'crypto';
import { ToolAdapter, SendOptions } from './base.js';
import { runCommand, commandExists, stripAnsi } from '../utils.js';

/**
 * Adapter for Claude Code CLI
 *
 * Claude Code supports:
 * - Non-interactive mode via -p/--print flag
 * - Output formats: text, json, stream-json
 * - Session continuation via --session-id (isolated from other sessions in same directory)
 */
export class ClaudeAdapter implements ToolAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly color = '\x1b[96m'; // brightCyan

  // Claude shows ❯ character when ready for input (with possible trailing chars like tool name)
  // Match: ❯ followed by optional text and arrow or end of string/line
  readonly promptPattern = /❯\s*(\w*\s*→)?.*$/m;

  // Fallback: if no output for 3 seconds, assume response complete
  // Claude Code can have brief pauses between output chunks during response generation
  readonly idleTimeout = 3000;

  // Claude starts relatively quickly (~2.5 seconds for first launch)
  readonly startupDelay = 2500;

  private hasActiveSession = false;

  // Unique session ID for aic's Claude sessions - prevents collision with
  // other Claude Code sessions running in the same directory
  private sessionId: string | null = null;

  // Track if we've used the session ID at least once (to know whether to use --session-id or --resume)
  private sessionCreated = false;

  async isAvailable(): Promise<boolean> {
    return commandExists('claude');
  }

  /**
   * Get or create a unique session ID for aic's Claude sessions.
   * This isolates aic from other Claude Code sessions in the same directory.
   */
  private getOrCreateSessionId(): string {
    if (!this.sessionId) {
      this.sessionId = randomUUID();
    }
    return this.sessionId;
  }

  /**
   * Get session args for Claude commands.
   * First call uses --session-id to CREATE the session.
   * Subsequent calls use --resume to CONTINUE the session (avoids "already in use" errors).
   */
  private getSessionArgs(): string[] {
    const sessionId = this.getOrCreateSessionId();
    if (!this.sessionCreated) {
      // First call - create the session with this ID
      // Mark as created immediately so subsequent calls use --resume
      // (even if this command fails, the session ID is reserved)
      this.sessionCreated = true;
      return ['--session-id', sessionId];
    } else {
      // Subsequent calls - resume the existing session
      return ['--resume', sessionId];
    }
  }

  getCommand(prompt: string, options?: SendOptions): string[] {
    // For slash commands, run without -p to access Claude's internal commands
    const isSlashCommand = prompt.startsWith('/');

    const args: string[] = [];

    if (!isSlashCommand) {
      args.push('-p'); // Print mode for regular prompts
      // Note: We intentionally don't enable --tools or --permission-mode here
      // This makes print mode read-only (no file edits without user consent)
      // Use /i (interactive mode) for full tool access with approvals
    }

    // Use session args to isolate and continue aic's sessions
    if (options?.continueSession !== false) {
      args.push(...this.getSessionArgs());
    }

    // Add the prompt as the last argument (only for non-slash commands in print mode)
    if (!isSlashCommand) {
      args.push(prompt);
    }

    return ['claude', ...args];
  }

  getInteractiveCommand(options?: SendOptions): string[] {
    const args: string[] = [];
    // Use session args to maintain isolated session
    if (options?.continueSession !== false) {
      args.push(...this.getSessionArgs());
    }
    return ['claude', ...args];
  }

  getPersistentArgs(): string[] {
    // Use session args for PTY - will create or resume as appropriate
    return this.getSessionArgs();
  }

  cleanResponse(rawOutput: string): string {
    let output = rawOutput;

    // Remove all ANSI escape sequences first
    output = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    output = output.replace(/\x1b\[\??\d+[hl]/g, '');
    output = output.replace(/\x1b\[\d* ?q/g, '');
    output = output.replace(/\x1b\][^\x07]*\x07/g, ''); // OSC sequences

    // Remove spinner frames
    output = output.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');

    // Remove box drawing characters
    output = output.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼║═╔╗╚╝╠╣╦╩╬▐▛▜▝▘]/g, '');

    // Remove common status line patterns (e.g., "Reading file...", "Thinking...")
    output = output.replace(/^(Reading|Writing|Analyzing|Thinking|Searching|Running).*$/gm, '');

    // Remove the prompt line itself (❯ followed by tool name → )
    output = output.replace(/❯\s*[a-z]+\s*→.*$/gm, '');
    output = output.replace(/❯\s*$/gm, '');

    // Remove Claude Code UI elements
    output = output.replace(/^\s*Claude Code v[\d.]+\s*$/gm, '');
    output = output.replace(/^\s*Opus.*API Usage.*$/gm, '');
    output = output.replace(/^\s*\/model to try.*$/gm, '');
    output = output.replace(/^\s*~\/.*$/gm, ''); // Directory paths
    // Remove suggestion prompts (can have > prefix or other characters)
    output = output.replace(/^[>\s]*\?\s*for shortcuts\s*$/gm, '');
    output = output.replace(/^[>\s]*Try ".*"\s*$/gm, '');
    // Also remove /ide for Cursor and similar suggestions
    output = output.replace(/^[>\s]*\/\w+\s+for\s+\w+\s*$/gm, '');

    // Remove typing hints and keyboard shortcuts help
    output = output.replace(/You can also use Ctrl\+P.*history.*$/gm, '');
    output = output.replace(/\(esc to cancel.*\)/g, '');
    output = output.replace(/^\s*no sandbox.*$/gm, '');
    output = output.replace(/^\s*auto\s*$/gm, '');

    // Remove welcome screen elements
    output = output.replace(/^\s*Welcome back!\s*$/gm, '');
    output = output.replace(/^\s*Tips for getting started\s*$/gm, '');
    output = output.replace(/^\s*Run \/init.*$/gm, '');
    output = output.replace(/^\s*Recent activity\s*$/gm, '');
    output = output.replace(/^\s*No recent activity\s*$/gm, '');

    // Remove tool use indicators (⏺ Read, ⏺ Write, etc.) but keep content
    output = output.replace(/^⏺\s+(Read|Write|Edit|Bash|Glob|Grep)\(.*\)\s*$/gm, '');
    output = output.replace(/^\s*⎿\s+.*$/gm, ''); // Tool result indicators

    // Extract response content - Claude responses often start with ⏺
    const responseBlocks: string[] = [];
    const lines = output.split('\n');
    let inResponse = false;
    let currentBlock: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Start of a response block (⏺ without tool name after it)
      if (trimmed.startsWith('⏺') && !trimmed.match(/^⏺\s+(Read|Write|Edit|Bash|Glob|Grep)/)) {
        if (currentBlock.length > 0) {
          responseBlocks.push(currentBlock.join('\n'));
        }
        currentBlock = [trimmed.replace(/^⏺\s*/, '')];
        inResponse = true;
      } else if (inResponse && trimmed.length > 0) {
        // Continue capturing response content
        if (!trimmed.match(/^[\s│─╭╮╰╯]*$/) && trimmed.length > 2) {
          currentBlock.push(line);
        }
      } else if (trimmed.length === 0 && inResponse) {
        currentBlock.push('');
      }
    }

    if (currentBlock.length > 0) {
      responseBlocks.push(currentBlock.join('\n'));
    }

    // If we found response blocks, use those; otherwise use cleaned output
    if (responseBlocks.length > 0) {
      output = responseBlocks.join('\n\n');
    }

    // Final cleanup
    output = output.replace(/\n{3,}/g, '\n\n');
    output = output.replace(/^\s+$/gm, '');

    return output.trim();
  }

  async send(prompt: string, options?: SendOptions): Promise<string> {
    // For print mode (-p), use non-interactive runCommand to avoid messing with stdin
    const args = this.getCommand(prompt, options).slice(1); // Remove 'claude' from start

    const result = await runCommand('claude', args, {
      cwd: options?.cwd || process.cwd(),
    });

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      throw new Error(`Claude Code exited with code ${result.exitCode}: ${errorMsg}`);
    }

    // Mark that we now have an active session
    this.hasActiveSession = true;

    // Return stdout (already plain text in print mode)
    return result.stdout.trim();
  }
  
  resetContext(): void {
    this.hasActiveSession = false;
    // Generate a new session ID on reset to start fresh
    this.sessionId = null;
    this.sessionCreated = false;
  }

  /** Check if there's an active session */
  hasSession(): boolean {
    return this.hasActiveSession;
  }

  /** Mark that a session exists (for loading from persisted state) */
  setHasSession(value: boolean): void {
    this.hasActiveSession = value;
  }

  /** Get current session ID (for debugging/logging) */
  getSessionId(): string | null {
    return this.sessionId;
  }
}
