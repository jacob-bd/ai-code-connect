import { ToolAdapter, SendOptions } from './base.js';
import { runCommand, commandExists, stripAnsi } from '../utils.js';

/**
 * Adapter for Claude Code CLI
 * 
 * Claude Code supports:
 * - Non-interactive mode via -p/--print flag
 * - Output formats: text, json, stream-json
 * - Session continuation via -c/--continue or -r/--resume
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
  
  async isAvailable(): Promise<boolean> {
    return commandExists('claude');
  }
  
  getCommand(prompt: string, options?: SendOptions): string[] {
    // For slash commands, run without -p to access Claude's internal commands
    const isSlashCommand = prompt.startsWith('/');
    
    const args: string[] = [];
    
    if (!isSlashCommand) {
      args.push('-p'); // Print mode for regular prompts
      // Enable tools in print mode (requires permission mode to auto-approve)
      args.push('--tools', 'default');
      args.push('--permission-mode', 'acceptEdits');
    }

    // Continue previous session if we've already made a call
    const shouldContinue = options?.continueSession !== false && this.hasActiveSession;
    if (shouldContinue) {
      args.push('--continue');
    }

    // Add the prompt as the last argument (only for non-slash commands in print mode)
    if (!isSlashCommand) {
      args.push(prompt);
    }
    
    return ['claude', ...args];
  }

  getInteractiveCommand(options?: SendOptions): string[] {
    const args: string[] = [];
    // Continue session if we have one
    if (options?.continueSession !== false && this.hasActiveSession) {
      args.push('--continue');
    }
    return ['claude', ...args];
  }

  getPersistentArgs(): string[] {
    // Continue previous session if we have one from regular mode
    if (this.hasActiveSession) {
      return ['--continue'];
    }
    return [];
  }

  cleanResponse(rawOutput: string): string {
    let output = rawOutput;

    // Remove spinner frames
    output = output.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');

    // Remove common status line patterns (e.g., "Reading file...", "Thinking...")
    output = output.replace(/^(Reading|Writing|Analyzing|Thinking|Searching|Running).*$/gm, '');

    // Remove the prompt line itself (❯ followed by tool name → )
    output = output.replace(/❯\s*[a-z]+\s*→.*$/gm, '');
    output = output.replace(/❯\s*$/gm, '');

    // Remove cursor movement and line clearing escape sequences
    output = output.replace(/\x1b\[\d*[ABCDEFGJKST]/g, '');
    output = output.replace(/\x1b\[\d*;\d*[Hf]/g, '');
    output = output.replace(/\x1b\[[\d;]*m/g, ''); // Color codes
    output = output.replace(/\x1b\[\??\d+[hl]/g, ''); // Mode changes
    output = output.replace(/\x1b\[\d* ?q/g, ''); // Cursor style

    // Clean up excessive whitespace
    output = output.replace(/\n{3,}/g, '\n\n');

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
  }
  
  /** Check if there's an active session */
  hasSession(): boolean {
    return this.hasActiveSession;
  }
  
  /** Mark that a session exists (for loading from persisted state) */
  setHasSession(value: boolean): void {
    this.hasActiveSession = value;
  }
}
