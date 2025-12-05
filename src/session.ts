import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ToolAdapter, AdapterRegistry } from './adapters/index.js';

export interface Message {
  role: 'user' | 'assistant';
  tool: string;
  content: string;
  timestamp: Date;
}

interface SerializedSession {
  messages: Array<{
    role: 'user' | 'assistant';
    tool: string;
    content: string;
    timestamp: string;
  }>;
  defaultTool: string;
  /** Track which tools have active sessions for context continuation */
  activeSessions: string[];
}

function getSessionPath(): string {
  const dir = join(homedir(), '.aic');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'session.json');
}

export interface ForwardOptions {
  /** Custom prefix to add when forwarding */
  prefix?: string;
  /** Whether to include the full history or just the last response */
  includeHistory?: boolean;
}

/**
 * Manages conversation sessions across multiple AI tools
 */
export class SessionManager {
  private messages: Message[] = [];
  private defaultTool: string;
  private registry: AdapterRegistry;
  
  constructor(registry: AdapterRegistry, defaultTool?: string) {
    this.registry = registry;
    this.defaultTool = defaultTool || 'claude';
  }
  
  /**
   * Get the current default tool
   */
  getDefaultTool(): string {
    return this.defaultTool;
  }
  
  /**
   * Set the default tool
   */
  setDefaultTool(toolName: string): void {
    if (!this.registry.get(toolName)) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    this.defaultTool = toolName;
  }
  
  /**
   * Get all messages in the session
   */
  getHistory(): Message[] {
    return [...this.messages];
  }
  
  /**
   * Get the last message from a specific tool
   */
  getLastResponse(toolName?: string): Message | undefined {
    const filtered = toolName 
      ? this.messages.filter(m => m.tool === toolName && m.role === 'assistant')
      : this.messages.filter(m => m.role === 'assistant');
    return filtered[filtered.length - 1];
  }
  
  /**
   * Add a user message to the session
   */
  addUserMessage(content: string, tool: string): void {
    this.messages.push({
      role: 'user',
      tool,
      content,
      timestamp: new Date(),
    });
  }
  
  /**
   * Add an assistant response to the session
   */
  addAssistantMessage(content: string, tool: string): void {
    this.messages.push({
      role: 'assistant',
      tool,
      content,
      timestamp: new Date(),
    });
  }
  
  /**
   * Send a message to a tool
   */
  async send(prompt: string, toolName?: string, options?: { keepStdinOpen?: boolean }): Promise<string> {
    const tool = this.registry.get(toolName || this.defaultTool);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName || this.defaultTool}`);
    }
    
    if (!await tool.isAvailable()) {
      throw new Error(`Tool ${tool.displayName} is not available`);
    }
    
    this.addUserMessage(prompt, tool.name);
    
    try {
      const response = await tool.send(prompt, { keepStdinOpen: options?.keepStdinOpen });
      this.addAssistantMessage(response, tool.name);
      return response;
    } catch (error) {
      // Remove the user message if the request failed
      this.messages.pop();
      throw error;
    }
  }
  
  /**
   * Forward the last response from one tool to another for review
   */
  async forward(
    fromTool: string,
    toTool: string,
    additionalPrompt?: string,
    options?: ForwardOptions & { keepStdinOpen?: boolean }
  ): Promise<string> {
    const lastResponse = this.getLastResponse(fromTool);
    if (!lastResponse) {
      throw new Error(`No response found from ${fromTool} to forward`);
    }
    
    const fromAdapter = this.registry.get(fromTool);
    const toAdapter = this.registry.get(toTool);
    
    if (!toAdapter) {
      throw new Error(`Unknown tool: ${toTool}`);
    }
    
    const prefix = options?.prefix || 
      `Another AI assistant (${fromAdapter?.displayName || fromTool}) proposed the following. Please review and provide feedback:\n\n---\n`;
    
    const suffix = additionalPrompt 
      ? `\n---\n\nAdditional context: ${additionalPrompt}`
      : '';
    
    const forwardPrompt = `${prefix}${lastResponse.content}${suffix}`;
    
    return this.send(forwardPrompt, toTool, { keepStdinOpen: options?.keepStdinOpen });
  }
  
  /**
   * Clear the session history and reset all tool contexts
   */
  clear(): void {
    this.messages = [];
    // Reset all tool sessions
    for (const adapter of this.registry.getAll()) {
      adapter.resetContext();
    }
  }
  
  /**
   * Format the session history for display
   */
  formatHistory(): string {
    if (this.messages.length === 0) {
      return 'No messages in session.';
    }
    
    return this.messages.map((msg, i) => {
      const time = msg.timestamp.toLocaleTimeString();
      const role = msg.role === 'user' ? 'You' : msg.tool;
      const preview = msg.content.length > 200 
        ? msg.content.slice(0, 200) + '...'
        : msg.content;
      return `[${i + 1}] ${time} - ${role}:\n${preview}`;
    }).join('\n\n');
  }
  
  /**
   * Save session to disk for persistence between CLI invocations
   */
  save(): void {
    // Collect which tools have active sessions
    const activeSessions: string[] = [];
    for (const adapter of this.registry.getAll()) {
      if (adapter.hasSession()) {
        activeSessions.push(adapter.name);
      }
    }
    
    const data: SerializedSession = {
      messages: this.messages.map(m => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
      defaultTool: this.defaultTool,
      activeSessions,
    };
    writeFileSync(getSessionPath(), JSON.stringify(data, null, 2));
  }
  
  /**
   * Load session from disk
   */
  load(): void {
    const path = getSessionPath();
    if (!existsSync(path)) {
      return;
    }
    
    try {
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content) as SerializedSession;
      
      this.messages = data.messages.map(m => ({
        ...m,
        timestamp: new Date(m.timestamp),
      }));
      
      if (data.defaultTool && this.registry.get(data.defaultTool)) {
        this.defaultTool = data.defaultTool;
      }
      
      // Restore active session state to adapters
      if (data.activeSessions) {
        for (const toolName of data.activeSessions) {
          const adapter = this.registry.get(toolName);
          if (adapter) {
            adapter.setHasSession(true);
          }
        }
      }
    } catch {
      // Ignore errors, start fresh
    }
  }
}

