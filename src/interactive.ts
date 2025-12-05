import { createInterface, Interface } from 'readline';
import { DaemonManager, DaemonConfig } from './daemon.js';
import { stripAnsi } from './utils.js';

// Daemon configurations
const CLAUDE_CONFIG: DaemonConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  args: [], // No args = interactive mode
  responseTimeout: 3000,
};

const GEMINI_CONFIG: DaemonConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  command: 'gemini',
  args: [], // No args = interactive mode
  responseTimeout: 3000,
};

/**
 * Interactive session with persistent daemons
 */
export class InteractiveSession {
  private manager: DaemonManager;
  private rl: Interface | null = null;
  private isRunning: boolean = false;
  private conversationHistory: Array<{tool: string; role: string; content: string}> = [];

  constructor() {
    this.manager = new DaemonManager();
    this.manager.register(CLAUDE_CONFIG);
    this.manager.register(GEMINI_CONFIG);
  }

  /**
   * Start the interactive session
   */
  async start(): Promise<void> {
    console.log('AI Code Connect - Persistent Session');
    console.log('─'.repeat(50));
    console.log('Starting Claude Code...\n');

    try {
      // Start only Claude initially (Gemini starts on-demand when switched to)
      await this.manager.startOne('claude');
    } catch (error) {
      console.error(`Failed to start Claude: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }

    console.log('\n' + '─'.repeat(50));
    console.log('Commands:');
    console.log('  //claude            - Switch to Claude');
    console.log('  //gemini            - Switch to Gemini');
    console.log('  //forward [msg]     - Forward last response to other tool');
    console.log('  //status            - Show daemon status');
    console.log('  //quit              - Exit');
    console.log('  (Single / commands like /cost go directly to the tool)');
    console.log('─'.repeat(50));
    console.log(`\nActive tool: ${this.manager.getActive()?.displayName}`);
    console.log('Type your message and press Enter. Output streams in real-time.\n');

    this.isRunning = true;
    await this.runLoop();
  }

  /**
   * Main input loop
   */
  private async runLoop(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      if (!this.isRunning) return;
      
      const activeDaemon = this.manager.getActive();
      const toolName = activeDaemon?.name || '?';
      
      this.rl!.question(`[${toolName}] > `, async (input) => {
        const trimmed = input.trim();
        
        if (!trimmed) {
          prompt();
          return;
        }

        // Handle our meta commands (double slash)
        if (trimmed.startsWith('//')) {
          await this.handleMetaCommand(trimmed.slice(2));
          prompt();
          return;
        }

        // Send to active daemon
        const daemon = this.manager.getActive();
        if (!daemon) {
          console.error('No active tool');
          prompt();
          return;
        }

        if (!daemon.isReady()) {
          console.error(`${daemon.displayName} is not ready`);
          prompt();
          return;
        }

        try {
          // Record the user message
          this.conversationHistory.push({
            tool: daemon.name,
            role: 'user',
            content: trimmed,
          });

          // Send and wait for response
          // Note: The response streams to stdout automatically via the daemon's data handler
          console.log(''); // newline before response
          const response = await daemon.send(trimmed);
          
          // Record the response (stripped of ANSI for storage)
          this.conversationHistory.push({
            tool: daemon.name,
            role: 'assistant',
            content: stripAnsi(response).trim(),
          });

          console.log(''); // newline after response
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : error}`);
        }

        prompt();
      });
    };

    prompt();
  }

  /**
   * Handle meta commands (///command)
   */
  private async handleMetaCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case 'quit':
      case 'exit':
        console.log('\nShutting down daemons...');
        this.manager.stopAll();
        this.isRunning = false;
        this.rl?.close();
        process.exit(0);
        break;

      case 'claude':
        await this.switchTool('claude');
        break;

      case 'gemini':
        await this.switchTool('gemini');
        break;

      case 'forward':
        await this.handleForward(parts.slice(1).join(' '));
        break;

      case 'status':
        this.showStatus();
        break;

      case 'history':
        this.showHistory();
        break;

      default:
        console.log(`Unknown command: //${command}`);
        console.log('Available: //claude, //gemini, //forward, //status, //quit');
    }
  }

  /**
   * Forward last response to the other tool
   */
  private async handleForward(additionalMessage: string): Promise<void> {
    // Find the last assistant response
    const lastResponse = [...this.conversationHistory]
      .reverse()
      .find(m => m.role === 'assistant');

    if (!lastResponse) {
      console.log('No response to forward yet.');
      return;
    }

    // Determine target daemon (opposite of the source)
    const sourceTool = lastResponse.tool;
    const targetTool = sourceTool === 'claude' ? 'gemini' : 'claude';

    const targetDaemon = this.manager.get(targetTool);
    if (!targetDaemon || !targetDaemon.isReady()) {
      console.log(`${targetTool} is not ready`);
      return;
    }

    // Switch to target
    this.manager.setActive(targetTool);

    // Build the forward prompt
    const sourceDisplayName = sourceTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    let forwardPrompt = `Another AI assistant (${sourceDisplayName}) provided this response. Please review and provide your thoughts:\n\n---\n${lastResponse.content}\n---`;
    
    if (additionalMessage) {
      forwardPrompt += `\n\nAdditional context: ${additionalMessage}`;
    }

    console.log(`\nForwarding to ${targetDaemon.displayName}...`);
    
    try {
      // Record the forward as a user message
      this.conversationHistory.push({
        tool: targetTool,
        role: 'user',
        content: forwardPrompt,
      });

      console.log(''); // newline before response
      const response = await targetDaemon.send(forwardPrompt);
      
      // Record the response
      this.conversationHistory.push({
        tool: targetTool,
        role: 'assistant',
        content: stripAnsi(response).trim(),
      });

      console.log(''); // newline after response
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Show daemon status
   */
  private showStatus(): void {
    console.log('\nDaemon Status:');
    for (const name of this.manager.getNames()) {
      const daemon = this.manager.get(name);
      if (daemon) {
        const isActive = this.manager.getActive()?.name === name;
        const status = daemon.getState();
        const marker = isActive ? '→' : ' ';
        console.log(`  ${marker} ${daemon.displayName.padEnd(15)} [${status}]`);
      }
    }
    console.log('');
  }

  /**
   * Switch to a different tool (starts it if not running)
   */
  private async switchTool(toolName: string): Promise<void> {
    const daemon = this.manager.get(toolName);
    if (!daemon) {
      console.log(`Unknown tool: ${toolName}`);
      return;
    }

    // Start the daemon if not running
    if (daemon.getState() === 'dead' || daemon.getState() === 'starting') {
      console.log(`Starting ${daemon.displayName}...`);
      try {
        await this.manager.startOne(toolName);
        console.log(`${daemon.displayName} is ready.`);
      } catch (error) {
        console.error(`Failed to start ${daemon.displayName}: ${error instanceof Error ? error.message : error}`);
        return;
      }
    }

    this.manager.setActive(toolName);
    console.log(`Switched to ${daemon.displayName}`);
  }

  /**
   * Show conversation history
   */
  private showHistory(): void {
    if (this.conversationHistory.length === 0) {
      console.log('\nNo conversation history yet.\n');
      return;
    }

    console.log('\nConversation History:');
    console.log('─'.repeat(50));
    
    for (let i = 0; i < this.conversationHistory.length; i++) {
      const msg = this.conversationHistory[i];
      const role = msg.role === 'user' ? 'You' : msg.tool;
      const preview = msg.content.length > 100 
        ? msg.content.slice(0, 100) + '...'
        : msg.content;
      console.log(`[${i + 1}] ${role}: ${preview}`);
    }
    
    console.log('─'.repeat(50) + '\n');
  }
}

/**
 * Start an interactive session
 */
export async function startInteractiveSession(): Promise<void> {
  const session = new InteractiveSession();
  await session.start();
}

