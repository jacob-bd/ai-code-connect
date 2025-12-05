import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { stripAnsi } from './utils.js';

interface Message {
  tool: string;
  role: 'user' | 'assistant';
  content: string;
}

// Ctrl+] character code
const DETACH_KEY = '\x1d'; // 0x1D = 29

// Spinner frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ANSI cursor control
const cursor = {
  show: '\x1b[?25h',
  hide: '\x1b[?25l',
  blockBlink: '\x1b[1 q',
  blockSteady: '\x1b[2 q',
  underlineBlink: '\x1b[3 q',
  underlineSteady: '\x1b[4 q',
  barBlink: '\x1b[5 q',
  barSteady: '\x1b[6 q',
};

// ANSI Color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Bright foreground
  brightCyan: '\x1b[96m',
  brightMagenta: '\x1b[95m',
  brightYellow: '\x1b[93m',
  brightGreen: '\x1b[92m',
  brightBlue: '\x1b[94m',
  brightWhite: '\x1b[97m',
  
  // Background
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

// ASCII Art banner for AIC²
const AIC_BANNER = `
${colors.brightCyan}     █████╗ ${colors.brightMagenta}██╗${colors.brightYellow} ██████╗ ${colors.dim}^2${colors.reset}
${colors.brightCyan}    ██╔══██╗${colors.brightMagenta}██║${colors.brightYellow}██╔════╝
${colors.brightCyan}    ███████║${colors.brightMagenta}██║${colors.brightYellow}██║     
${colors.brightCyan}    ██╔══██║${colors.brightMagenta}██║${colors.brightYellow}██║     
${colors.brightCyan}    ██║  ██║${colors.brightMagenta}██║${colors.brightYellow}╚██████╗
${colors.brightCyan}    ╚═╝  ╚═╝${colors.brightMagenta}╚═╝${colors.brightYellow} ╚═════╝${colors.reset}
`;

const TAGLINE = `${colors.dim}─────${colors.reset} ${colors.brightCyan}A${colors.brightMagenta}I${colors.reset} ${colors.brightYellow}C${colors.white}ode${colors.reset} ${colors.brightYellow}C${colors.white}onnect${colors.reset} ${colors.dim}─────${colors.reset}`;

function drawBox(content: string[], width: number = 50): string {
  const top = `${colors.gray}╭${'─'.repeat(width - 2)}╮${colors.reset}`;
  const bottom = `${colors.gray}╰${'─'.repeat(width - 2)}╯${colors.reset}`;
  const lines = content.map(line => {
    const padding = width - 4 - stripAnsiLength(line);
    return `${colors.gray}│${colors.reset} ${line}${' '.repeat(Math.max(0, padding))} ${colors.gray}│${colors.reset}`;
  });
  return [top, ...lines, bottom].join('\n');
}

function stripAnsiLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

class Spinner {
  private intervalId: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private message: string;

  constructor(message: string = 'Thinking') {
    this.message = message;
  }

  start(): void {
    this.frameIndex = 0;
    process.stdout.write(`\n${SPINNER_FRAMES[0]} ${this.message}...`);
    
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      // Move cursor back and overwrite
      process.stdout.write(`\r${SPINNER_FRAMES[this.frameIndex]} ${this.message}...`);
    }, 80);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      // Clear the spinner line
      process.stdout.write('\r' + ' '.repeat(this.message.length + 15) + '\r');
    }
  }
}

/**
 * Session with persistent interactive mode support
 * - Regular messages: uses -p (print mode) with --continue/--resume
 * - Interactive mode: persistent PTY process, detach with Ctrl+]
 */
export class SDKSession {
  private rl: Interface | null = null;
  private isRunning = false;
  private activeTool: 'claude' | 'gemini' = 'claude';
  private conversationHistory: Message[] = [];
  
  // Session tracking (for print mode)
  private claudeHasSession = false;
  private geminiHasSession = false;
  
  // Persistent PTY processes for interactive mode
  private runningProcesses: Map<string, IPty> = new Map();
  
  // Buffer to capture interactive mode output for forwarding
  private interactiveOutputBuffer: Map<string, string> = new Map();
  
  // Working directory
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  async start(): Promise<void> {
    // Ensure cursor is visible
    process.stdout.write(cursor.show + cursor.blockBlink);
    
    // Clear screen and show splash
    console.clear();
    console.log(AIC_BANNER);
    console.log(TAGLINE);
    console.log('');
    
    // Show working directory
    console.log(`${colors.dim}📁 ${this.cwd}${colors.reset}`);
    console.log('');
    
    // Commands box
    const commands = [
      `${colorize('//claude', colors.brightCyan)}          Switch to Claude Code`,
      `${colorize('//gemini', colors.brightMagenta)}          Switch to Gemini CLI`,
      `${colorize('//i', colors.brightYellow)}               Enter interactive mode`,
      `${colorize('//forward', colors.brightGreen)} ${colors.dim}[msg]${colors.reset}    Forward last response`,
      `${colorize('//history', colors.blue)}         Show conversation`,
      `${colorize('//status', colors.gray)}          Show running processes`,
      `${colorize('//clear', colors.red)}           Clear sessions`,
      `${colorize('//quit', colors.dim)}            Exit ${colors.dim}(or //cya)${colors.reset}`,
    ];
    console.log(drawBox(commands, 52));
    console.log('');
    
    // Tips
    console.log(`${colors.dim}💡 Press ${colors.brightYellow}Ctrl+]${colors.dim} to detach from interactive mode${colors.reset}`);
    console.log(`${colors.dim}💡 Sessions persist with ${colors.cyan}--continue${colors.dim}/${colors.magenta}--resume${colors.reset}`);
    console.log('');
    
    // Show active tool
    const toolColor = this.activeTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const toolName = this.activeTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    console.log(`${colors.green}●${colors.reset} Active: ${toolColor}${toolName}${colors.reset}`);
    console.log('');

    this.isRunning = true;
    await this.runLoop();
  }

  private getPrompt(): string {
    const toolColor = this.activeTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const toolName = this.activeTool === 'claude' ? 'claude' : 'gemini';
    // Ensure cursor is visible and set to blinking block, then show prompt
    return `${cursor.show}${cursor.blockBlink}${toolColor}❯ ${toolName}${colors.reset} ${colors.dim}→${colors.reset} `;
  }

  private async runLoop(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      if (!this.isRunning) return;
      
      this.rl!.question(this.getPrompt(), async (input) => {
        // Filter out iTerm focus events and other escape sequences
        const cleaned = input
          .replace(/\x1b\[I/g, '')  // Focus in
          .replace(/\x1b\[O/g, '')  // Focus out
          .replace(/\^\[\[I/g, '')  // Focus in (literal)
          .replace(/\^\[\[O/g, '')  // Focus out (literal)
          .trim();
        const trimmed = cleaned;

        if (!trimmed) {
          prompt();
          return;
        }

        // Handle meta commands (double slash)
        if (trimmed.startsWith('//')) {
          await this.handleMetaCommand(trimmed.slice(2));
          prompt();
          return;
        }

        // Send to active tool
        await this.sendToTool(trimmed);
        prompt();
      });
    };

    prompt();
  }

  private async handleMetaCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case 'quit':
      case 'exit':
      case 'cya':
        await this.cleanup();
        console.log(`\n${colors.brightYellow}👋 Goodbye!${colors.reset}\n`);
        this.isRunning = false;
        this.rl?.close();
        process.exit(0);
        break;

      case 'claude':
        this.activeTool = 'claude';
        console.log(`${colors.green}●${colors.reset} Switched to ${colors.brightCyan}Claude Code${colors.reset}`);
        break;

      case 'gemini':
        this.activeTool = 'gemini';
        console.log(`${colors.green}●${colors.reset} Switched to ${colors.brightMagenta}Gemini CLI${colors.reset}`);
        break;

      case 'forward':
        await this.handleForward(parts.slice(1).join(' '));
        break;

      case 'interactive':
      case 'shell':
      case 'i':
        await this.enterInteractiveMode();
        break;

      case 'history':
        this.showHistory();
        break;

      case 'status':
        this.showStatus();
        break;

      case 'clear':
        await this.cleanup();
        this.claudeHasSession = false;
        this.geminiHasSession = false;
        this.conversationHistory = [];
        console.log('Sessions and history cleared.');
        break;

      default:
        console.log(`Unknown command: //${command}`);
    }
  }

  private async sendToTool(message: string): Promise<void> {
    // Record user message
    this.conversationHistory.push({
      tool: this.activeTool,
      role: 'user',
      content: message,
    });

    try {
      let response: string;
      
      if (this.activeTool === 'claude') {
        response = await this.sendToClaude(message);
      } else {
        response = await this.sendToGemini(message);
      }

      // Record assistant response
      this.conversationHistory.push({
        tool: this.activeTool,
        role: 'assistant',
        content: response,
      });
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : error}\n`);
      // Remove the user message if failed
      this.conversationHistory.pop();
    }
  }

  private sendToClaude(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-p']; // Print mode
      
      // Continue session if we have one
      if (this.claudeHasSession) {
        args.push('--continue');
      }
      
      // Add the message
      args.push(message);

      // Start spinner
      const spinner = new Spinner(`${colors.brightCyan}Claude${colors.reset} is thinking`);
      spinner.start();
      let firstOutput = true;
      
      const proc = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        // Stop spinner on first output
        if (firstOutput) {
          spinner.stop();
          console.log(''); // newline before response
          firstOutput = false;
        }
        const text = data.toString();
        process.stdout.write(text); // Stream output
        stdout += text;
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        spinner.stop(); // Ensure spinner is stopped
        if (!firstOutput) {
          console.log(''); // newline after response
        }
        
        if (code !== 0) {
          reject(new Error(`Claude exited with code ${code}: ${stderr || stdout}`));
        } else {
          this.claudeHasSession = true; // Mark that we now have a session
          resolve(stripAnsi(stdout).trim());
        }
      });

      proc.on('error', (err) => {
        spinner.stop();
        reject(err);
      });
    });
  }

  private sendToGemini(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = [];
      
      // Resume session if we have one
      if (this.geminiHasSession) {
        args.push('--resume', 'latest');
      }
      
      // Add the message
      args.push(message);

      // Start spinner
      const spinner = new Spinner(`${colors.brightMagenta}Gemini${colors.reset} is thinking`);
      spinner.start();
      let firstOutput = true;
      
      const proc = spawn('gemini', args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        // Stop spinner on first output
        if (firstOutput) {
          spinner.stop();
          console.log(''); // newline before response
          firstOutput = false;
        }
        const text = data.toString();
        process.stdout.write(text); // Stream output
        stdout += text;
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        spinner.stop(); // Ensure spinner is stopped
        if (!firstOutput) {
          console.log(''); // newline after response
        }
        
        if (code !== 0) {
          reject(new Error(`Gemini exited with code ${code}: ${stderr || stdout}`));
        } else {
          this.geminiHasSession = true; // Mark that we now have a session
          resolve(stripAnsi(stdout).trim());
        }
      });

      proc.on('error', (err) => {
        spinner.stop();
        reject(err);
      });
    });
  }

  /**
   * Enter full interactive mode with the active tool.
   * - If a process is already running, re-attach to it
   * - If not, spawn a new one
   * - Press Ctrl+] to detach (process keeps running)
   * - Use /exit in the tool to terminate the process
   */
  private async enterInteractiveMode(): Promise<void> {
    const toolName = this.activeTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    const toolColor = this.activeTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const command = this.activeTool;
    
    // Check if we already have a running process
    let ptyProcess = this.runningProcesses.get(this.activeTool);
    const isReattach = ptyProcess !== undefined;

    if (isReattach) {
      console.log(`\n${colors.green}↩${colors.reset} Re-attaching to ${toolColor}${toolName}${colors.reset}...`);
    } else {
      console.log(`\n${colors.green}▶${colors.reset} Starting ${toolColor}${toolName}${colors.reset} interactive mode...`);
    }
    console.log(`${colors.dim}Press ${colors.brightYellow}Ctrl+]${colors.dim} to detach • ${colors.white}/exit${colors.dim} to terminate${colors.reset}\n`);
    
    // Clear the output buffer for fresh capture
    this.interactiveOutputBuffer.set(this.activeTool, '');

    // Pause readline while in interactive mode
    this.rl?.pause();

    return new Promise((resolve) => {
      // Spawn new process if needed
      if (!ptyProcess) {
        const args: string[] = [];
        
        // Continue/resume session if we have history from print mode
        if (this.activeTool === 'claude' && this.claudeHasSession) {
          args.push('--continue');
        } else if (this.activeTool === 'gemini' && this.geminiHasSession) {
          args.push('--resume', 'latest');
        }

        ptyProcess = pty.spawn(command, args, {
          name: 'xterm-256color',
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
          cwd: this.cwd,
          env: process.env as { [key: string]: string },
        });

        // Store the process
        this.runningProcesses.set(this.activeTool, ptyProcess);

        // Handle process exit (user typed /exit in the tool)
        ptyProcess.onExit(({ exitCode }) => {
          console.log(`\n${colors.dim}${toolName} exited (code ${exitCode})${colors.reset}`);
          this.runningProcesses.delete(this.activeTool);
          
          // Mark session as having history
          if (this.activeTool === 'claude') {
            this.claudeHasSession = true;
          } else {
            this.geminiHasSession = true;
          }
        });
      }

      // Handle resize
      const onResize = () => {
        ptyProcess!.resize(
          process.stdout.columns || 80,
          process.stdout.rows || 24
        );
      };
      process.stdout.on('resize', onResize);

      // Pipe PTY output to terminal AND capture for forwarding
      const outputDisposable = ptyProcess.onData((data) => {
        process.stdout.write(data);
        // Capture output for potential forwarding
        const current = this.interactiveOutputBuffer.get(this.activeTool) || '';
        this.interactiveOutputBuffer.set(this.activeTool, current + data);
      });

      // Set up stdin forwarding with Ctrl+] detection
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      let detached = false;

      const onStdinData = (data: Buffer) => {
        const str = data.toString();
        
        // Check for Ctrl+] (detach key)
        if (str === DETACH_KEY) {
          detached = true;
          cleanup();
          
          // Save captured output to conversation history for forwarding
          const capturedOutput = this.interactiveOutputBuffer.get(this.activeTool);
          if (capturedOutput) {
            const cleanedOutput = stripAnsi(capturedOutput).trim();
            if (cleanedOutput.length > 50) { // Only save meaningful output
              this.conversationHistory.push({
                tool: this.activeTool,
                role: 'assistant',
                content: cleanedOutput,
              });
            }
            // Clear buffer after saving
            this.interactiveOutputBuffer.set(this.activeTool, '');
          }
          
          console.log(`\n\n${colors.yellow}⏸${colors.reset} Detached from ${toolColor}${toolName}${colors.reset} ${colors.dim}(still running)${colors.reset}`);
          console.log(`${colors.dim}Use ${colors.brightYellow}//i${colors.dim} to re-attach • ${colors.brightGreen}//forward${colors.dim} to send to other tool${colors.reset}\n`);
          this.rl?.resume();
          resolve();
          return;
        }
        
        // Forward to PTY
        ptyProcess!.write(str);
      };
      process.stdin.on('data', onStdinData);

      // Handle process exit while attached
      const exitHandler = () => {
        if (!detached) {
          cleanup();
          console.log(`\n${colors.dim}Returned to ${colors.brightYellow}aic${colors.reset}\n`);
          this.rl?.resume();
          resolve();
        }
      };
      ptyProcess.onExit(exitHandler);

      // Cleanup function
      const cleanup = () => {
        process.stdin.removeListener('data', onStdinData);
        process.stdout.removeListener('resize', onResize);
        outputDisposable.dispose();
        
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
      };
    });
  }

  private showStatus(): void {
    console.log('');
    const claudeRunning = this.runningProcesses.has('claude');
    const geminiRunning = this.runningProcesses.has('gemini');
    
    const statusLines = [
      `${colors.brightCyan}◆ Claude Code${colors.reset}  ${claudeRunning ? `${colors.green}● Running${colors.reset}` : `${colors.dim}○ Stopped${colors.reset}`}  ${this.claudeHasSession ? `${colors.dim}(has history)${colors.reset}` : ''}`,
      `${colors.brightMagenta}◇ Gemini CLI${colors.reset}   ${geminiRunning ? `${colors.green}● Running${colors.reset}` : `${colors.dim}○ Stopped${colors.reset}`}  ${this.geminiHasSession ? `${colors.dim}(has history)${colors.reset}` : ''}`,
    ];
    
    console.log(drawBox(statusLines, 45));
    console.log('');
  }

  private async handleForward(additionalMessage: string): Promise<void> {
    // Find the last assistant response
    const lastResponse = [...this.conversationHistory]
      .reverse()
      .find(m => m.role === 'assistant');

    if (!lastResponse) {
      console.log('No response to forward yet.');
      return;
    }

    // Switch to the other tool
    const sourceTool = lastResponse.tool;
    const targetTool = sourceTool === 'claude' ? 'gemini' : 'claude';
    this.activeTool = targetTool as 'claude' | 'gemini';

    const sourceDisplayName = sourceTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    const targetDisplayName = targetTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    const sourceColor = sourceTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const targetColor = targetTool === 'claude' ? colors.brightCyan : colors.brightMagenta;

    console.log('');
    console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.green}↗${colors.reset} Forwarding from ${sourceColor}${sourceDisplayName}${colors.reset} → ${targetColor}${targetDisplayName}${colors.reset}`);
    console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${targetColor}${targetDisplayName} responds:${colors.reset}`);

    // Build forward prompt
    let forwardPrompt = `Another AI assistant (${sourceDisplayName}) provided this response. Please review and share your thoughts:\n\n---\n${lastResponse.content}\n---`;
    
    if (additionalMessage) {
      forwardPrompt += `\n\nAdditional context: ${additionalMessage}`;
    }

    await this.sendToTool(forwardPrompt);
  }

  private showHistory(): void {
    if (this.conversationHistory.length === 0) {
      console.log(`\n${colors.dim}No conversation history yet.${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.bold}Conversation History${colors.reset}`);
    console.log(`${colors.dim}${'─'.repeat(50)}${colors.reset}`);

    for (let i = 0; i < this.conversationHistory.length; i++) {
      const msg = this.conversationHistory[i];
      const isUser = msg.role === 'user';
      const toolColor = msg.tool === 'claude' ? colors.brightCyan : colors.brightMagenta;
      
      let roleDisplay: string;
      if (isUser) {
        roleDisplay = `${colors.yellow}You${colors.reset}`;
      } else {
        roleDisplay = `${toolColor}${msg.tool}${colors.reset}`;
      }
      
      const preview = msg.content.length > 80
        ? msg.content.slice(0, 80) + '...'
        : msg.content;
      console.log(`${colors.dim}${String(i + 1).padStart(2)}.${colors.reset} ${roleDisplay}: ${colors.white}${preview}${colors.reset}`);
    }

    console.log(`${colors.dim}${'─'.repeat(50)}${colors.reset}\n`);
  }

  private async cleanup(): Promise<void> {
    // Kill any running processes
    for (const [tool, proc] of this.runningProcesses) {
      console.log(`Stopping ${tool}...`);
      proc.kill();
    }
    this.runningProcesses.clear();
  }
}

export async function startSDKSession(): Promise<void> {
  const session = new SDKSession();
  await session.start();
}
