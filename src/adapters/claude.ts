import { ToolAdapter, SendOptions } from './base.js';
import { runCommandPty, commandExists, stripAnsi } from '../utils.js';

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
    }
    
    // Continue previous session if we've already made a call
    const shouldContinue = options?.continueSession !== false && this.hasActiveSession;
    if (shouldContinue) {
      args.push('--continue');
    }
    
    if (options?.cwd) {
      args.push('--add-dir', options.cwd);
    }
    
    // Add the prompt as the last argument (only for non-slash commands in print mode)
    if (!isSlashCommand) {
      args.push(prompt);
    }
    
    return ['claude', ...args];
  }
  
  async send(prompt: string, options?: SendOptions): Promise<string> {
    const isSlashCommand = prompt.startsWith('/');
    const args = this.getCommand(prompt, options).slice(1); // Remove 'claude' from start
    
    console.log(''); // Add newline before output
    
    const result = await runCommandPty('claude', args, {
      cwd: options?.cwd || process.cwd(),
      keepStdinOpen: options?.keepStdinOpen,
      // For slash commands, we'll write the command after Claude starts
      initialInput: isSlashCommand ? prompt + '\n' : undefined,
    });
    
    if (result.exitCode !== 0 && !isSlashCommand) {
      throw new Error(`Claude Code exited with code ${result.exitCode}`);
    }
    
    // Mark that we now have an active session
    this.hasActiveSession = true;
    
    // Return the captured output (strip ANSI for storage, but it was displayed with colors)
    return stripAnsi(result.output).trim();
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
