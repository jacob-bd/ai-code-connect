import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import serializeAddonPkg from '@xterm/addon-serialize';
import { stripAnsi } from './utils.js';

// ESM/CJS compatibility
const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddonPkg;

/**
 * State machine for persistent PTY lifecycle
 */
export enum PtyState {
  SPAWNING = 'spawning',   // PTY starting up, waiting for first prompt
  IDLE = 'idle',           // Showing prompt, ready for input
  PROCESSING = 'processing', // Tool is generating a response
  ATTACHED = 'attached',   // User is in interactive mode
  DEAD = 'dead'            // Process exited, needs respawn
}

/**
 * Configuration for a persistent PTY session
 */
export interface PtyConfig {
  /** Tool name (e.g., 'claude', 'gemini') */
  name: string;
  /** Command to run (e.g., 'claude', 'gemini') */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Regex pattern to detect when tool is ready for input */
  promptPattern: RegExp;
  /** Fallback timeout in ms - if no output for this long, assume response complete */
  idleTimeout: number;
  /** Function to clean response output (remove UI noise) */
  cleanResponse: (raw: string) => string;
  /** ANSI color for this tool */
  color: string;
  /** Display name for this tool */
  displayName: string;
}

/**
 * Callback types for PTY events
 */
export interface PtyCallbacks {
  /** Called when PTY process exits */
  onExit?: (exitCode: number) => void;
  /** Called when state changes */
  onStateChange?: (state: PtyState) => void;
}

/**
 * Pending response capture
 */
interface ResponseCapture {
  output: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  idleTimeoutId?: NodeJS.Timeout;
  startTime: number;
}

// Terminal sequences to filter
const FOCUS_IN_SEQ = '\x1b[I';
const FOCUS_OUT_SEQ = '\x1b[O';

/**
 * Manages a persistent PTY session for a single tool.
 *
 * The PTY runs continuously in the background:
 * - Regular messages: Write to stdin, capture response via prompt detection
 * - Interactive mode: Attach (forward stdin/stdout), detach (keep running)
 */
export class PersistentPtyManager {
  private pty: IPty | null = null;
  private state: PtyState = PtyState.DEAD;
  private outputBuffer: string = '';
  private currentCapture: ResponseCapture | null = null;
  private callbacks: PtyCallbacks = {};
  private cwd: string = process.cwd();

  // Headless terminal for proper screen state tracking
  // This handles cursor positioning, screen clears, etc. properly
  private headlessTerminal: InstanceType<typeof Terminal> | null = null;
  private serializeAddon: InstanceType<typeof SerializeAddon> | null = null;

  // For attach/detach
  private isAttached: boolean = false;
  private attachedOutputHandler: ((data: string) => void) | null = null;

  // Track if we've seen the first prompt (tool is ready)
  private isReady: boolean = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  // Flag to suppress exit messages when intentionally killed
  private suppressExitMessage: boolean = false;

  constructor(private config: PtyConfig) {}

  /**
   * Initialize the headless terminal for screen state tracking.
   * This is used to properly capture output when tools use cursor positioning
   * to redraw content (like Gemini's streaming).
   */
  private initHeadlessTerminal(): void {
    this.headlessTerminal = new Terminal({
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      scrollback: 1000, // Keep scrollback for longer responses
    });
    this.serializeAddon = new SerializeAddon();
    this.headlessTerminal.loadAddon(this.serializeAddon);
  }

  /**
   * Get current state
   */
  getState(): PtyState {
    return this.state;
  }

  /**
   * Check if PTY is dead and needs respawn
   */
  isDead(): boolean {
    return this.state === PtyState.DEAD;
  }

  /**
   * Check if PTY is processing a response
   */
  isProcessing(): boolean {
    return this.state === PtyState.PROCESSING;
  }

  /**
   * Check if user is currently attached
   */
  isUserAttached(): boolean {
    return this.isAttached;
  }

  /**
   * Get the output buffer (for reattach screen restore)
   * Uses the headless terminal to get the actual visible screen content.
   */
  getOutputBuffer(): string {
    // If we have a headless terminal, extract visible text from the screen
    // This correctly handles cursor positioning and screen redraws
    if (this.headlessTerminal) {
      try {
        const buffer = this.headlessTerminal.buffer.active;
        const lines: string[] = [];

        // Only read the VISIBLE viewport, not the scrollback
        // This avoids capturing intermediate streaming frames
        const viewportStart = buffer.baseY;
        const viewportEnd = viewportStart + this.headlessTerminal.rows;

        for (let y = viewportStart; y < viewportEnd && y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (line) {
            // translateToString(true) = trim trailing whitespace
            lines.push(line.translateToString(true));
          }
        }

        // Join lines and trim empty lines from start/end
        let text = lines.join('\n').trim();

        // If viewport is mostly empty (just prompt), try getting more from scrollback
        if (text.length < 50 && buffer.length > viewportEnd) {
          // Get the last screenful from scrollback instead
          const scrollbackLines: string[] = [];
          const startY = Math.max(0, buffer.length - this.headlessTerminal.rows * 2);
          for (let y = startY; y < buffer.length; y++) {
            const line = buffer.getLine(y);
            if (line) {
              scrollbackLines.push(line.translateToString(true));
            }
          }
          text = scrollbackLines.join('\n').trim();
        }

        if (text.length > 0) {
          return text;
        }
      } catch {
        // Fall back to raw buffer if extraction fails
      }
    }
    return this.outputBuffer;
  }

  /**
   * Clear the output buffer (used after sending a prompt to avoid capturing the typed input)
   */
  clearOutputBuffer(): void {
    this.outputBuffer = '';
    // Also reset the headless terminal
    if (this.headlessTerminal) {
      this.headlessTerminal.reset();
    }
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: PtyCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Spawn the PTY process
   * @param cwd Working directory
   * @param waitForReady If false, returns immediately after spawning (for interactive mode)
   */
  spawn(cwd: string, waitForReady: boolean = true): Promise<void> {
    if (this.pty && this.state !== PtyState.DEAD) {
      return Promise.resolve();
    }

    this.cwd = cwd;
    this.state = PtyState.SPAWNING;
    this.outputBuffer = '';
    this.isReady = false;

    // Initialize headless terminal for screen state tracking
    this.initHeadlessTerminal();

    // Create a promise that resolves when we see the first prompt OR after short timeout
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;

      // Short fallback: if we don't detect prompt within 2 seconds, assume ready anyway
      // For interactive mode, users will see the startup screen directly
      setTimeout(() => {
        if (!this.isReady && this.state === PtyState.SPAWNING) {
          this.isReady = true;
          this.setState(PtyState.IDLE);
          resolve();
        }
      }, 2000);
    });

    this.pty = pty.spawn(this.config.command, this.config.args, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: this.cwd,
      env: process.env as { [key: string]: string },
    });

    // Handle output
    this.pty.onData((data: string) => {
      this.handleData(data);
    });

    // Handle exit
    this.pty.onExit(({ exitCode }) => {
      this.handleExit(exitCode);
    });

    // Handle resize
    const onResize = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      if (this.pty) {
        this.pty.resize(cols, rows);
      }
      // Also resize the headless terminal to match
      if (this.headlessTerminal) {
        this.headlessTerminal.resize(cols, rows);
      }
    };
    process.stdout.on('resize', onResize);

    // For interactive mode, return immediately so user sees startup
    if (!waitForReady) {
      return Promise.resolve();
    }

    return this.readyPromise;
  }

  /**
   * Handle incoming data from PTY
   */
  private handleData(data: string): void {
    // Detect screen clears and reset buffer
    if (data.includes('\x1b[2J') || data.includes('\x1b[H\x1b[2J')) {
      this.outputBuffer = '';
    }

    // Add to buffer (raw, kept for backwards compatibility)
    this.outputBuffer += data;

    // Also write to headless terminal for proper screen state tracking
    // This correctly handles cursor positioning, screen redraws, etc.
    if (this.headlessTerminal) {
      this.headlessTerminal.write(data);
    }

    // Limit buffer size (keep last 100KB)
    const MAX_BUFFER = 100 * 1024;
    if (this.outputBuffer.length > MAX_BUFFER) {
      this.outputBuffer = this.outputBuffer.slice(-MAX_BUFFER);
    }

    // If attached, forward to stdout (filtered)
    if (this.isAttached) {
      let filteredData = data
        .split(FOCUS_IN_SEQ).join('')
        .split(FOCUS_OUT_SEQ).join('');

      // Filter terminal response sequences that leak through
      // These include DA responses, keyboard protocol responses, etc.
      const beforeFilter = filteredData;
      filteredData = filteredData
        .replace(/\x1b\[\?[\d;]*[uc]/g, '')     // ESC[?...c or ESC[?...u (full sequences)
        .replace(/\x1b\[>[\d;]*c/g, '')         // ESC[>...c (Secondary DA)
        .replace(/\x1b\[[\d;]*u/g, '')          // ESC[...u (CSI u)
        .replace(/\x1b\[c/g, '')                // ESC[c Primary DA query - DON'T send to terminal!
        .replace(/\x1b\[>c/g, '')               // ESC[>c Secondary DA query
        // Orphaned remnants from fragmented escape sequences
        .replace(/\b0u\b/g, '')                 // Keyboard enhancement "0u"
        .replace(/\b\d{2,};[\d;]+c\b/g, '');    // DA response "64;1;2;...c"

      // Debug: log filtered sequences when AIC_DEBUG=1
      if (process.env.AIC_DEBUG === '1' && beforeFilter !== filteredData) {
        console.log(`\n[DEBUG] PTY filtered ${beforeFilter.length - filteredData.length} bytes of terminal sequences`);
      }

      if (filteredData.length > 0) {
        process.stdout.write(filteredData);
      }
    }

    // Check for prompt (tool is ready for input)
    const strippedRecent = stripAnsi(this.outputBuffer.slice(-500));
    if (this.config.promptPattern.test(strippedRecent)) {
      // Tool is showing prompt
      if (!this.isReady) {
        // First prompt - tool is initialized
        this.isReady = true;
        this.setState(PtyState.IDLE);
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
      } else if (this.currentCapture) {
        // We have a pending capture and saw prompt - response is complete!
        this.completeCapture();
      } else if (this.state === PtyState.PROCESSING) {
        // Was processing, now idle
        this.setState(PtyState.IDLE);
      }
    }

    // If capturing, accumulate output
    if (this.currentCapture) {
      this.currentCapture.output += data;

      // Only reset idle timeout on "real" content, not spinner/ANSI noise
      // Strip ANSI codes and spinner frames to check if there's actual content
      const stripped = data
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI codes
        .replace(/\x1b\[\??\d+[hl]/g, '')        // Mode changes
        .replace(/\x1b\[\d* ?q/g, '')            // Cursor style
        .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')           // Spinner frames
        .replace(/\r/g, '')                       // Carriage returns
        .trim();

      // Only reset timer if there's actual content (not just control sequences)
      if (stripped.length > 0) {
        this.resetIdleTimeout();
      }
    }
  }

  /**
   * Reset the idle timeout (called on each output chunk)
   */
  private resetIdleTimeout(): void {
    if (!this.currentCapture) return;

    // Clear existing idle timeout
    if (this.currentCapture.idleTimeoutId) {
      clearTimeout(this.currentCapture.idleTimeoutId);
    }

    // Set new idle timeout
    this.currentCapture.idleTimeoutId = setTimeout(() => {
      // No output for idleTimeout ms - assume response is complete
      if (this.currentCapture) {
        this.completeCapture();
      }
    }, this.config.idleTimeout);
  }

  /**
   * Complete the current response capture
   */
  private completeCapture(): void {
    if (!this.currentCapture) return;

    // Clear timeouts
    clearTimeout(this.currentCapture.timeoutId);
    if (this.currentCapture.idleTimeoutId) {
      clearTimeout(this.currentCapture.idleTimeoutId);
    }

    // Clean and resolve
    const rawOutput = this.currentCapture.output;
    const cleanedOutput = this.config.cleanResponse(rawOutput);
    this.currentCapture.resolve(cleanedOutput);
    this.currentCapture = null;
    this.setState(PtyState.IDLE);
  }

  /**
   * Handle PTY exit
   */
  private handleExit(exitCode: number): void {
    this.setState(PtyState.DEAD);
    this.pty = null;
    this.isReady = false;

    // If killed silently, don't show messages or call callbacks
    if (this.suppressExitMessage) {
      this.suppressExitMessage = false;
      return;
    }

    // Reject any pending capture
    if (this.currentCapture) {
      clearTimeout(this.currentCapture.timeoutId);
      if (this.currentCapture.idleTimeoutId) {
        clearTimeout(this.currentCapture.idleTimeoutId);
      }
      this.currentCapture.reject(new Error(`${this.config.displayName} exited with code ${exitCode}`));
      this.currentCapture = null;
    }

    // Notify callback
    if (this.callbacks.onExit) {
      this.callbacks.onExit(exitCode);
    }
  }

  /**
   * Set state and notify callback
   */
  private setState(state: PtyState): void {
    if (this.state !== state) {
      this.state = state;
      if (this.callbacks.onStateChange) {
        this.callbacks.onStateChange(state);
      }
    }
  }

  /**
   * Send a message and capture the response.
   * Waits for prompt detection or idle timeout to know when complete.
   */
  async sendAndCapture(message: string, timeout: number = 120000): Promise<string> {
    // Ensure PTY is running
    if (this.state === PtyState.DEAD) {
      await this.spawn(this.cwd);
    }

    // Wait for tool to be ready (only if not ready yet)
    if (!this.isReady && this.readyPromise) {
      await this.readyPromise;
    }
    // Clear the promise once resolved to avoid holding references
    this.readyPromise = null;

    // Can't send while already processing
    if (this.state === PtyState.PROCESSING) {
      throw new Error(`${this.config.displayName} is still processing a previous request`);
    }

    // Can't send while attached
    if (this.isAttached) {
      throw new Error(`Cannot send message while attached. Use /i to interact directly.`);
    }

    return new Promise<string>((resolve, reject) => {
      // Set up capture
      const timeoutId = setTimeout(() => {
        if (this.currentCapture) {
          if (this.currentCapture.idleTimeoutId) {
            clearTimeout(this.currentCapture.idleTimeoutId);
          }
          this.currentCapture = null;
          this.setState(PtyState.IDLE);
          reject(new Error(`Response timeout after ${timeout / 1000} seconds`));
        }
      }, timeout);

      this.currentCapture = {
        output: '',
        resolve,
        reject,
        timeoutId,
        startTime: Date.now()
      };

      // Start idle timeout
      this.resetIdleTimeout();

      // Send message
      this.setState(PtyState.PROCESSING);
      this.pty!.write(message + '\n');
    });
  }

  /**
   * Write directly to PTY (for interactive mode)
   */
  write(data: string): void {
    if (this.pty && this.state !== PtyState.DEAD) {
      this.pty.write(data);
    }
  }

  /**
   * Attach to PTY - forward output to stdout, allow stdin forwarding
   */
  attach(): void {
    if (this.isAttached) return;
    this.isAttached = true;
    this.setState(PtyState.ATTACHED);
  }

  /**
   * Detach from PTY - stop forwarding, PTY keeps running
   */
  detach(): void {
    if (!this.isAttached) return;
    this.isAttached = false;
    // Don't change state if PTY is dead - preserve the DEAD state
    // so getOrCreateManager knows to spawn a new PTY
    if (this.state !== PtyState.DEAD) {
      this.setState(PtyState.IDLE);
    }
  }

  /**
   * Kill the PTY process
   * @param silent If true, suppress the onExit callback (for intentional kills)
   */
  kill(silent: boolean = false): void {
    if (silent) {
      // Set flag to suppress exit message in handleExit
      this.suppressExitMessage = true;
    }
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    // Dispose headless terminal
    if (this.headlessTerminal) {
      this.headlessTerminal.dispose();
      this.headlessTerminal = null;
      this.serializeAddon = null;
    }
    this.setState(PtyState.DEAD);
  }

  /**
   * Get the underlying PTY for advanced operations
   */
  getPty(): IPty | null {
    return this.pty;
  }
}
