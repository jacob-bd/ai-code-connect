import { ToolAdapter, SendOptions } from './base.js';
import { runCommand, commandExists, stripAnsi } from '../utils.js';

/**
 * Adapter for Gemini CLI
 * 
 * Gemini CLI supports:
 * - Non-interactive mode via positional query argument
 * - Output formats: text, json, stream-json (via -o/--output-format)
 * - Session resume via -r/--resume
 * - YOLO mode via -y/--yolo for auto-approval
 */
export class GeminiAdapter implements ToolAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly color = '\x1b[95m'; // brightMagenta

  // Gemini shows > at start of line when ready for input
  readonly promptPattern = /^>\s*$/m;

  // Fallback: if no output for 1.5 seconds, assume response complete
  readonly idleTimeout = 1500;

  // Gemini is slower to start (~8 seconds for first launch due to auth/loading)
  readonly startupDelay = 8000;

  private hasActiveSession = false;
  
  async isAvailable(): Promise<boolean> {
    return commandExists('gemini');
  }
  
  getCommand(prompt: string, options?: SendOptions): string[] {
    const args: string[] = [];
    
    // Resume previous session if we've already made a call
    const shouldContinue = options?.continueSession !== false && this.hasActiveSession;
    if (shouldContinue) {
      args.push('--resume', 'latest');
    }

    // Note: Don't use --include-directories here because it takes an array and would
    // consume the prompt. The cwd is set when spawning the process.

    // Add the prompt as the last argument (positional)
    args.push(prompt);
    
    return ['gemini', ...args];
  }

  getInteractiveCommand(options?: SendOptions): string[] {
    const args: string[] = [];
    // Resume session if we have one
    if (options?.continueSession !== false && this.hasActiveSession) {
      args.push('--resume', 'latest');
    }
    return ['gemini', ...args];
  }

  getPersistentArgs(): string[] {
    // Resume previous session if we have one from regular mode
    if (this.hasActiveSession) {
      return ['--resume', 'latest'];
    }
    return [];
  }

  cleanResponse(rawOutput: string): string {
    let output = rawOutput;

    // Remove "Loaded cached credentials." line
    output = output.replace(/Loaded cached credentials\.?\s*/g, '');

    // Remove spinner frames
    output = output.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');

    // Remove the prompt line itself
    output = output.replace(/^>\s*$/gm, '');

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
    // Use non-interactive runCommand to avoid messing with stdin
    const args = this.getCommand(prompt, options).slice(1); // Remove 'gemini' from start

    const result = await runCommand('gemini', args, {
      cwd: options?.cwd || process.cwd(),
    });

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      throw new Error(`Gemini CLI exited with code ${result.exitCode}: ${errorMsg}`);
    }

    // Mark that we now have an active session
    this.hasActiveSession = true;

    // Return stdout
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
