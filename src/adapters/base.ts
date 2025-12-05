/**
 * Base interface for AI CLI tool adapters
 */
export interface SendOptions {
  /** Working directory for the tool */
  cwd?: string;
  /** Whether to continue the previous session (default: true) */
  continueSession?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Keep stdin open after command (for interactive sessions) */
  keepStdinOpen?: boolean;
}

export interface ToolAdapter {
  /** Unique name identifier for the tool */
  readonly name: string;
  
  /** Display name for the tool */
  readonly displayName: string;
  
  /** Check if the tool is installed and available */
  isAvailable(): Promise<boolean>;
  
  /** Send a prompt to the tool and get a response */
  send(prompt: string, options?: SendOptions): Promise<string>;
  
  /** Reset conversation context */
  resetContext(): void;
  
  /** Get the command that would be executed (for debugging) */
  getCommand(prompt: string, options?: SendOptions): string[];
  
  /** Check if there's an active session with this tool */
  hasSession(): boolean;
  
  /** Set whether there's an active session (for persistence) */
  setHasSession(value: boolean): void;
}

/**
 * Registry of available tool adapters
 */
export class AdapterRegistry {
  private adapters: Map<string, ToolAdapter> = new Map();
  
  register(adapter: ToolAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }
  
  get(name: string): ToolAdapter | undefined {
    return this.adapters.get(name);
  }
  
  getAll(): ToolAdapter[] {
    return Array.from(this.adapters.values());
  }
  
  getNames(): string[] {
    return Array.from(this.adapters.keys());
  }
  
  async getAvailable(): Promise<ToolAdapter[]> {
    const available: ToolAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      if (await adapter.isAvailable()) {
        available.push(adapter);
      }
    }
    return available;
  }
}

