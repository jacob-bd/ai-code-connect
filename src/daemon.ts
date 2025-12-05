import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { stripAnsi } from './utils.js';

export interface DaemonConfig {
  name: string;
  displayName: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Regex pattern to detect when tool is ready for input */
  promptPattern?: RegExp;
  /** Timeout (ms) to assume response is complete if no new output */
  responseTimeout?: number;
  /** Timeout (ms) to wait for initial startup */
  startupTimeout?: number;
}

export type DaemonState = 'starting' | 'ready' | 'busy' | 'interactive' | 'dead';

/**
 * Manages a persistent AI tool process (Claude or Gemini)
 * Allows sending commands and capturing responses without restarting
 */
export class ToolDaemon extends EventEmitter {
  private pty: pty.IPty | null = null;
  private config: DaemonConfig;
  private state: DaemonState = 'starting';
  private outputBuffer: string = '';
  private responseBuffer: string = '';
  private lastResponse: string = '';
  private responseResolver: ((response: string) => void) | null = null;
  private responseTimeoutId: NodeJS.Timeout | null = null;
  private interactiveStdinHandler: ((data: Buffer) => void) | null = null;

  constructor(config: DaemonConfig) {
    super();
    this.config = {
      responseTimeout: 3000, // 3 seconds of silence = response complete
      startupTimeout: 60000, // 60 seconds to start
      ...config,
    };
  }

  get name(): string {
    return this.config.name;
  }

  get displayName(): string {
    return this.config.displayName;
  }

  getState(): DaemonState {
    return this.state;
  }

  getLastResponse(): string {
    return this.lastResponse;
  }

  /**
   * Start the daemon process
   */
  async start(): Promise<void> {
    if (this.pty) {
      throw new Error(`${this.config.displayName} daemon is already running`);
    }

    return new Promise((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error(`${this.config.displayName} startup timeout`));
      }, this.config.startupTimeout);

      console.log(`Starting ${this.config.displayName}...`);

      this.pty = pty.spawn(this.config.command, this.config.args, {
        name: 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd: this.config.cwd || process.cwd(),
        env: process.env as { [key: string]: string },
      });

      // Handle terminal resize
      const onResize = () => {
        if (this.pty) {
          this.pty.resize(
            process.stdout.columns || 80,
            process.stdout.rows || 24
          );
        }
      };
      process.stdout.on('resize', onResize);

      // Handle data from the tool
      this.pty.onData((data) => {
        this.outputBuffer += data;
        
        // Always emit data for display
        this.emit('data', data);

        // If we're waiting for a response, accumulate it
        if (this.state === 'busy' && this.responseResolver) {
          this.responseBuffer += data;
          this.resetResponseTimeout();
        }

        // Check if we've reached initial ready state
        if (this.state === 'starting') {
          // Use prompt pattern or timeout to detect ready state
          if (this.config.promptPattern && this.config.promptPattern.test(stripAnsi(this.outputBuffer))) {
            this.state = 'ready';
            clearTimeout(startupTimeout);
            console.log(`${this.config.displayName} is ready.`);
            resolve();
          }
        }
      });

      // Handle process exit
      this.pty.onExit(({ exitCode }) => {
        this.state = 'dead';
        process.stdout.removeListener('resize', onResize);
        this.emit('exit', exitCode);
        console.log(`${this.config.displayName} exited with code ${exitCode}`);
      });

      // If no prompt pattern, use timeout to detect ready
      if (!this.config.promptPattern) {
        setTimeout(() => {
          if (this.state === 'starting') {
            this.state = 'ready';
            clearTimeout(startupTimeout);
            console.log(`${this.config.displayName} is ready.`);
            resolve();
          }
        }, 5000); // Give it 5 seconds to start
      }
    });
  }

  /**
   * Reset the response timeout (called when new data arrives)
   */
  private resetResponseTimeout(): void {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
    }
    this.responseTimeoutId = setTimeout(() => {
      this.completeResponse();
    }, this.config.responseTimeout);
  }

  /**
   * Complete the current response and resolve the promise
   */
  private completeResponse(): void {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
      this.responseTimeoutId = null;
    }

    if (this.responseResolver) {
      const response = this.responseBuffer;
      this.lastResponse = stripAnsi(response).trim();
      this.responseResolver(response);
      this.responseResolver = null;
      this.responseBuffer = '';
      this.state = 'ready';
    }
  }

  /**
   * Send a command to the tool and wait for the response
   */
  async send(command: string): Promise<string> {
    if (!this.pty) {
      throw new Error(`${this.config.displayName} daemon is not running`);
    }
    if (this.state !== 'ready') {
      throw new Error(`${this.config.displayName} is not ready (state: ${this.state})`);
    }

    return new Promise((resolve) => {
      this.state = 'busy';
      this.responseBuffer = '';
      this.responseResolver = resolve;
      
      // Send the command
      this.pty!.write(command + '\n');
      
      // Start response timeout
      this.resetResponseTimeout();
    });
  }

  /**
   * Enter interactive mode - user gets direct control
   */
  enterInteractiveMode(): void {
    if (!this.pty) {
      throw new Error(`${this.config.displayName} daemon is not running`);
    }

    this.state = 'interactive';
    
    // Set up stdin forwarding
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    this.interactiveStdinHandler = (data: Buffer) => {
      if (this.pty) {
        this.pty.write(data.toString());
      }
    };
    process.stdin.on('data', this.interactiveStdinHandler);
  }

  /**
   * Exit interactive mode - return to programmatic control
   */
  exitInteractiveMode(): void {
    if (this.interactiveStdinHandler) {
      process.stdin.removeListener('data', this.interactiveStdinHandler);
      this.interactiveStdinHandler = null;
    }
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    
    this.state = 'ready';
  }

  /**
   * Write raw data to the tool (for interactive mode)
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    if (this.interactiveStdinHandler) {
      this.exitInteractiveMode();
    }
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    this.state = 'dead';
  }

  /**
   * Check if the daemon is running and ready
   */
  isReady(): boolean {
    return this.state === 'ready';
  }
}

/**
 * Manages multiple tool daemons
 */
export class DaemonManager {
  private daemons: Map<string, ToolDaemon> = new Map();
  private activeDaemon: string | null = null;
  private displayHandler: ((data: string) => void) | null = null;

  /**
   * Register a daemon configuration
   */
  register(config: DaemonConfig): void {
    const daemon = new ToolDaemon(config);
    this.daemons.set(config.name, daemon);
  }

  /**
   * Start all registered daemons (sequentially to avoid output conflicts)
   */
  async startAll(): Promise<void> {
    for (const daemon of this.daemons.values()) {
      await this.setupAndStartDaemon(daemon);
    }
    
    // Set first daemon as active
    const firstDaemon = this.daemons.keys().next().value;
    if (firstDaemon) {
      this.activeDaemon = firstDaemon;
    }
  }

  /**
   * Start a single daemon by name
   */
  async startOne(name: string): Promise<void> {
    const daemon = this.daemons.get(name);
    if (!daemon) {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    if (daemon.getState() !== 'starting' && daemon.getState() !== 'dead') {
      // Already running
      return;
    }
    
    await this.setupAndStartDaemon(daemon);
    this.activeDaemon = name;
  }

  /**
   * Set up data handler and start a daemon
   */
  private async setupAndStartDaemon(daemon: ToolDaemon): Promise<void> {
    // Set up data handler for display (only if not already set up)
    if (!daemon.listenerCount('data')) {
      daemon.on('data', (data: string) => {
        // Only display if this is the active daemon
        if (this.activeDaemon === daemon.name) {
          if (this.displayHandler) {
            this.displayHandler(data);
          } else {
            process.stdout.write(data);
          }
        }
      });
    }
    
    await daemon.start();
  }

  /**
   * Get a daemon by name
   */
  get(name: string): ToolDaemon | undefined {
    return this.daemons.get(name);
  }

  /**
   * Get the active daemon
   */
  getActive(): ToolDaemon | null {
    if (this.activeDaemon) {
      return this.daemons.get(this.activeDaemon) || null;
    }
    return null;
  }

  /**
   * Set the active daemon
   */
  setActive(name: string): void {
    if (!this.daemons.has(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    // Exit interactive mode on previous daemon if active
    const previousDaemon = this.getActive();
    if (previousDaemon && previousDaemon.getState() === 'interactive') {
      previousDaemon.exitInteractiveMode();
    }
    
    this.activeDaemon = name;
  }

  /**
   * Set the display handler for output
   */
  setDisplayHandler(handler: (data: string) => void): void {
    this.displayHandler = handler;
  }

  /**
   * Get all daemon names
   */
  getNames(): string[] {
    return Array.from(this.daemons.keys());
  }

  /**
   * Stop all daemons
   */
  stopAll(): void {
    for (const daemon of this.daemons.values()) {
      daemon.stop();
    }
    this.daemons.clear();
    this.activeDaemon = null;
  }
}

