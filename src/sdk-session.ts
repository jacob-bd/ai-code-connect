import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface, CompleterResult } from 'readline';
import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { stripAnsi } from './utils.js';

// Configure marked to render markdown for terminal with colors
marked.setOptions({
  // @ts-ignore - marked-terminal types not fully compatible
  renderer: new TerminalRenderer({
    // Customize colors
    codespan: (code: string) => `\x1b[93m${code}\x1b[0m`, // Yellow for inline code
    strong: (text: string) => `\x1b[1m${text}\x1b[0m`,    // Bold
    em: (text: string) => `\x1b[3m${text}\x1b[0m`,        // Italic
  })
});

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

const VERSION = 'v1.0.0';
const TAGLINE = `${colors.dim}─────${colors.reset} ${colors.brightCyan}A${colors.brightMagenta}I${colors.reset} ${colors.brightYellow}C${colors.white}ode${colors.reset} ${colors.brightYellow}C${colors.white}onnect${colors.reset} ${colors.dim}${VERSION} ─────${colors.reset}`;

// Tool configuration - add new tools here
interface ToolConfig {
  name: string;
  displayName: string;
  color: string;
}

const AVAILABLE_TOOLS: ToolConfig[] = [
  { name: 'claude', displayName: 'Claude Code', color: colors.brightCyan },
  { name: 'gemini', displayName: 'Gemini CLI', color: colors.brightMagenta },
  // Add new tools here, e.g.:
  // { name: 'codex', displayName: 'Codex CLI', color: colors.brightGreen },
];

function getToolConfig(name: string): ToolConfig | undefined {
  return AVAILABLE_TOOLS.find(t => t.name === name);
}

function getToolColor(name: string): string {
  return getToolConfig(name)?.color || colors.white;
}

function getToolDisplayName(name: string): string {
  return getToolConfig(name)?.displayName || name;
}

// AIC command definitions
const AIC_COMMANDS = [
  { value: '//claude', name: `${colors.brightCyan}//claude${colors.reset}       Switch to Claude Code`, description: 'Switch to Claude Code' },
  { value: '//gemini', name: `${colors.brightMagenta}//gemini${colors.reset}       Switch to Gemini CLI`, description: 'Switch to Gemini CLI' },
  { value: '//i', name: `${colors.brightYellow}//i${colors.reset}            Enter interactive mode`, description: 'Enter interactive mode (Ctrl+] to detach)' },
  { value: '//forward', name: `${colors.brightGreen}//forward${colors.reset}      Forward last response`, description: 'Forward response: //forward [tool] [msg]' },
  { value: '//history', name: `${colors.blue}//history${colors.reset}      Show conversation`, description: 'Show conversation history' },
  { value: '//status', name: `${colors.gray}//status${colors.reset}       Show running processes`, description: 'Show daemon status' },
  { value: '//clear', name: `${colors.red}//clear${colors.reset}        Clear sessions`, description: 'Clear sessions and history' },
  { value: '//quit', name: `${colors.dim}//quit${colors.reset}         Exit`, description: 'Exit AIC' },
  { value: '//cya', name: `${colors.dim}//cya${colors.reset}          Exit (alias)`, description: 'Exit AIC' },
];

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
  
  // Readline interface for input with history
  private rl: Interface | null = null;
  private inputHistory: string[] = [];

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
      `${colorize('//forward', colors.brightGreen)} ${colors.dim}[tool] [msg]${colors.reset} Forward response`,
      `${colorize('//history', colors.blue)}         Show conversation`,
      `${colorize('//status', colors.gray)}          Show running processes`,
      `${colorize('//clear', colors.red)}           Clear sessions`,
      `${colorize('//quit', colors.dim)}            Exit ${colors.dim}(or //cya)${colors.reset}`,
    ];
    console.log(drawBox(commands, 52));
    console.log('');
    
    // Tips
    console.log(`${colors.dim}💡 Press ${colors.brightYellow}Tab${colors.dim} to autocomplete commands${colors.reset}`);
    console.log(`${colors.dim}💡 Press ${colors.brightYellow}↑/↓${colors.dim} to cycle through command history${colors.reset}`);
    console.log(`${colors.dim}💡 Press ${colors.brightYellow}Ctrl+]${colors.dim} to detach from interactive mode${colors.reset}`);
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
    return `${toolColor}❯ ${toolName}${colors.reset} ${colors.dim}→${colors.reset} `;
  }

  /**
   * Tab completion for // commands
   */
  private completer(line: string): CompleterResult {
    const commands = ['//claude', '//gemini', '//i', '//forward', '//history', '//status', '//clear', '//quit', '//cya'];
    
    // Only complete if line starts with /
    if (line.startsWith('/')) {
      const hits = commands.filter(c => c.startsWith(line));
      // Show all commands if no specific match, or show matches
      return [hits.length ? hits : commands, line];
    }
    
    // No completion for regular input
    return [[], line];
  }

  private setupReadline(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: this.completer.bind(this),
      history: this.inputHistory,
      historySize: 100,
      prompt: this.getPrompt(),
    });

    // Handle Ctrl+C gracefully
    this.rl.on('SIGINT', () => {
      console.log('\n');
      this.rl?.close();
      this.cleanup().then(() => {
        console.log(`${colors.brightYellow}👋 Goodbye!${colors.reset}\n`);
        process.exit(0);
      });
    });
  }

  private async runLoop(): Promise<void> {
    this.setupReadline();
    await this.promptLoop();
  }

  private async promptLoop(): Promise<void> {
    while (this.isRunning) {
      const input = await this.readInput();
      
      if (!input || !input.trim()) continue;
      
      const trimmed = input.trim();

      // Add to history (readline handles this, but we track for persistence)
      if (trimmed && !this.inputHistory.includes(trimmed)) {
        this.inputHistory.push(trimmed);
        // Keep history manageable
        if (this.inputHistory.length > 100) {
          this.inputHistory.shift();
        }
      }

      // Handle meta commands (double slash)
      if (trimmed.startsWith('//')) {
        await this.handleMetaCommand(trimmed.slice(2));
        continue;
      }

      // Send to active tool
      await this.sendToTool(trimmed);
    }
  }

  private readInput(): Promise<string> {
    return new Promise((resolve) => {
      // Update prompt in case tool changed
      this.rl?.setPrompt(this.getPrompt());
      this.rl?.prompt();
      
      this.rl?.once('line', (line) => {
        resolve(line);
      });
    });
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
      
      const proc = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        spinner.stop();
        
        if (code !== 0) {
          reject(new Error(`Claude exited with code ${code}: ${stderr || stdout}`));
        } else {
          // Render the response with markdown formatting
          console.log('');
          const rendered = marked.parse(stdout.trim()) as string;
          process.stdout.write(rendered);
          console.log('');
          
          this.claudeHasSession = true;
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
      
      const proc = spawn('gemini', args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        spinner.stop();
        
        if (code !== 0) {
          reject(new Error(`Gemini exited with code ${code}: ${stderr || stdout}`));
        } else {
          // Render the response with markdown formatting
          console.log('');
          const rendered = marked.parse(stdout.trim()) as string;
          process.stdout.write(rendered);
          console.log('');
          
          this.geminiHasSession = true;
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

    // Interactive mode takes over stdin

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
    
    const statusLines = AVAILABLE_TOOLS.map(tool => {
      const isRunning = this.runningProcesses.has(tool.name);
      const hasSession = tool.name === 'claude' ? this.claudeHasSession : this.geminiHasSession;
      const icon = tool.name === 'claude' ? '◆' : '◇';
      return `${tool.color}${icon} ${tool.displayName.padEnd(12)}${colors.reset} ${isRunning ? `${colors.green}● Running${colors.reset}` : `${colors.dim}○ Stopped${colors.reset}`}  ${hasSession ? `${colors.dim}(has history)${colors.reset}` : ''}`;
    });
    
    console.log(drawBox(statusLines, 45));
    console.log('');
  }

  private async handleForward(argsString: string): Promise<void> {
    // Find the last assistant response
    const lastResponse = [...this.conversationHistory]
      .reverse()
      .find(m => m.role === 'assistant');

    if (!lastResponse) {
      console.log('No response to forward yet.');
      return;
    }

    const sourceTool = lastResponse.tool;
    const otherTools = AVAILABLE_TOOLS
      .map(t => t.name)
      .filter(t => t !== sourceTool);

    // Parse args: first word might be a tool name
    const parts = argsString.trim().split(/\s+/).filter(p => p);
    let targetTool: string;
    let additionalMessage: string;

    if (parts.length > 0 && otherTools.includes(parts[0].toLowerCase())) {
      // First arg is a tool name
      targetTool = parts[0].toLowerCase();
      additionalMessage = parts.slice(1).join(' ');
    } else {
      // No tool specified - auto-select if only one other tool
      if (otherTools.length === 1) {
        targetTool = otherTools[0];
        additionalMessage = argsString;
      } else {
        // Multiple tools available - require explicit selection
        console.log(`${colors.yellow}Multiple tools available.${colors.reset} Please specify target:`);
        console.log(`  ${colors.brightGreen}//forward${colors.reset} <${otherTools.join('|')}> [message]`);
        return;
      }
    }

    // Validate target tool exists and is not the source
    if (targetTool === sourceTool) {
      console.log(`Cannot forward to the same tool (${sourceTool}).`);
      return;
    }

    // Switch to target tool
    this.activeTool = targetTool as 'claude' | 'gemini';

    const sourceDisplayName = getToolDisplayName(sourceTool);
    const targetDisplayName = getToolDisplayName(targetTool);
    const sourceColor = getToolColor(sourceTool);
    const targetColor = getToolColor(targetTool);

    console.log('');
    console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.green}↗${colors.reset} Forwarding from ${sourceColor}${sourceDisplayName}${colors.reset} → ${targetColor}${targetDisplayName}${colors.reset}`);
    console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${targetColor}${targetDisplayName} responds:${colors.reset}`);

    // Build forward prompt
    let forwardPrompt = `Another AI assistant (${sourceDisplayName}) provided this response. Please review and share your thoughts:\n\n---\n${lastResponse.content}\n---`;
    
    if (additionalMessage.trim()) {
      forwardPrompt += `\n\nAdditional context: ${additionalMessage.trim()}`;
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
