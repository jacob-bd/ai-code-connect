import { ToolAdapter, SendOptions } from './base.js';
import { runCommandPty, commandExists, stripAnsi } from '../utils.js';

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
    
    if (options?.cwd) {
      args.push('--include-directories', options.cwd);
    }
    
    // Add the prompt as the last argument (positional)
    args.push(prompt);
    
    return ['gemini', ...args];
  }
  
  async send(prompt: string, options?: SendOptions): Promise<string> {
    const args = this.getCommand(prompt, options).slice(1); // Remove 'gemini' from start
    
    console.log(''); // Add newline before output
    
    const result = await runCommandPty('gemini', args, {
      cwd: options?.cwd || process.cwd(),
      keepStdinOpen: options?.keepStdinOpen,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Gemini CLI exited with code ${result.exitCode}`);
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
