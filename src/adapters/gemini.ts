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
  private hasStartedInteractiveSession = false;

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
    // Resume previous session if we have one from regular mode OR
    // if we've already started an interactive session (for respawns after exit)
    if (this.hasActiveSession || this.hasStartedInteractiveSession) {
      return ['--resume', 'latest'];
    }
    return [];
  }

  cleanResponse(rawOutput: string): string {
    let output = rawOutput;

    // Remove all ANSI escape sequences first
    output = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    output = output.replace(/\x1b\[\??\d+[hl]/g, '');
    output = output.replace(/\x1b\[\d* ?q/g, '');
    output = output.replace(/\x1b\][^\x07]*\x07/g, ''); // OSC sequences

    // Remove "Loaded cached credentials." line
    output = output.replace(/Loaded cached credentials\.?\s*/g, '');

    // Remove spinner frames
    output = output.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');

    // Remove box drawing characters and lines made of them
    output = output.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼║═╔╗╚╝╠╣╦╩╬]/g, '');

    // Remove Gemini UI-specific lines
    output = output.replace(/^\s*Using:.*MCP servers?\s*$/gm, '');
    output = output.replace(/^\s*~\/.*\(main\*?\).*$/gm, ''); // Directory status line
    output = output.replace(/^\s*~\/[^\n]*$/gm, ''); // Any directory path line
    output = output.replace(/^\s*no sandbox.*$/gim, '');
    output = output.replace(/^\s*auto\s*$/gm, '');
    output = output.replace(/^\s*Reading.*\(esc to cancel.*\)\s*$/gm, '');
    output = output.replace(/^\s*Type your message or @path.*$/gm, '');
    output = output.replace(/^\s*>\s*Type your message.*$/gm, '');
    output = output.replace(/^\s*\?\s*for shortcuts\s*$/gm, '');
    output = output.replace(/^\s*Try ".*"\s*$/gm, ''); // Suggestion lines

    // Remove thinking/incubating indicators
    output = output.replace(/^\s*∴ Thought for.*$/gm, '');
    output = output.replace(/^\s*✽ Incubating.*$/gm, '');
    output = output.replace(/\(ctrl\+o to show thinking\)/gi, '');
    output = output.replace(/\(esc to interrupt\)/gi, '');
    output = output.replace(/\(esc to cancel.*\)/gi, '');

    // Remove tool status lines (✓ ReadFolder, ✓ ReadFile, etc.)
    output = output.replace(/^\s*[✓✗]\s+\w+.*$/gm, '');

    // Remove the prompt character
    output = output.replace(/^>\s*$/gm, '');

    // Remove "... generating more ..." markers
    output = output.replace(/\.\.\.\s*generating more\s*\.\.\./gi, '');

    // GEMINI-SPECIFIC: Gemini streams code progressively with status indicators.
    // Each indicator is followed by a progressively more complete code block.
    // Unlike Claude (which streams text progressively), Gemini REDRAWS from the beginning.
    // We need to find the LAST occurrence and keep only that final complete block.
    const streamingPatterns = [
      /Defining the Response Strategy/gi,
      /Formulating\s+\w+\s+Code/gi,
      /Formulating\s+\w+\s+Response/gi,
      /Considering\s+the\s+Response\s+Format/gi,
      /Presenting\s+the\s+Code/gi,
      /Presenting\s+the\s+Response/gi,
      /Providing\s+\w+\s+Code\s+Example/gi,
      /Generating\s+\w+\s+Code/gi,
      /Writing\s+the\s+Code/gi,
    ];

    // Find the position after the LAST streaming indicator
    let lastIndicatorEnd = 0;
    for (const pattern of streamingPatterns) {
      const regex = new RegExp(pattern.source, 'gi');
      let match;
      while ((match = regex.exec(output)) !== null) {
        const endPos = match.index + match[0].length;
        if (endPos > lastIndicatorEnd) {
          lastIndicatorEnd = endPos;
        }
      }
    }

    // If we found streaming indicators, take only content after the last one
    if (lastIndicatorEnd > 0) {
      output = output.substring(lastIndicatorEnd).trim();
    } else {
      // Fallback: try the ✦ marker
      const lastMarkerIndex = output.lastIndexOf('✦');
      if (lastMarkerIndex >= 0) {
        output = output.substring(lastMarkerIndex + 1).trim();
      }
    }

    // Clean up any remaining line-based garbage
    const cleanedLines = output.split('\n').filter(line => {
      const trimmed = line.trim();
      // Skip empty UI elements
      if (trimmed.match(/^[\s│─╭╮╰╯]*$/) && trimmed.length < 3) return false;
      return true;
    });
    output = cleanedLines.join('\n');

    // Final cleanup
    output = output.replace(/\n{3,}/g, '\n\n');
    output = output.replace(/^\s+$/gm, ''); // Lines with only whitespace

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
    this.hasStartedInteractiveSession = false;
  }

  /** Mark that an interactive session has been started (for PTY respawns) */
  markInteractiveSessionStarted(): void {
    this.hasStartedInteractiveSession = true;
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
