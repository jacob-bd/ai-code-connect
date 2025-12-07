import { createInterface, Interface, CompleterResult } from 'readline';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { stripAnsi, commandExists } from './utils.js';
import { getDefaultTool, setDefaultTool } from './config.js';
import { VERSION } from './version.js';
import { AdapterRegistry } from './adapters/base.js';
import { PersistentPtyManager, PtyState, PtyConfig } from './persistent-pty.js';

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

// Constants
const MAX_HISTORY_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 120000;

// Detach key codes - multiple options for compatibility across terminals
// Traditional raw control characters (used by Terminal.app and others)
const DETACH_KEYS = {
  CTRL_BRACKET: 0x1d,      // Ctrl+] = 0x1D = 29
  CTRL_BACKSLASH: 0x1c,    // Ctrl+\ = 0x1C = 28
  CTRL_CARET: 0x1e,        // Ctrl+^ = 0x1E = 30 (Ctrl+Shift+6 on US keyboards)
  CTRL_UNDERSCORE: 0x1f,   // Ctrl+_ = 0x1F = 31 (Ctrl+Shift+- on US keyboards)
  ESCAPE: 0x1b,            // Escape = 0x1B = 27
};

// CSI u sequences - modern keyboard protocol used by iTerm2
// Format: ESC [ <keycode> ; <modifiers> u
// Modifier 5 = Ctrl (4) + 1
const CSI_U_DETACH_SEQS = [
  '\x1b[93;5u',   // Ctrl+] (keycode 93 = ])
  '\x1b[92;5u',   // Ctrl+\ (keycode 92 = \)
  '\x1b[54;5u',   // Ctrl+^ / Ctrl+6 (keycode 54 = 6)
  '\x1b[45;5u',   // Ctrl+_ / Ctrl+- (keycode 45 = -)
  '\x1b[54;6u',   // Ctrl+Shift+6 (modifier 6 = Ctrl+Shift)
  '\x1b[45;6u',   // Ctrl+Shift+- (modifier 6 = Ctrl+Shift)
];

// Terminal sequences to filter out
// Focus reporting - sent by terminals when window gains/loses focus
const FOCUS_IN_SEQ = '\x1b[I';   // ESC [ I - Focus gained
const FOCUS_OUT_SEQ = '\x1b[O';  // ESC [ O - Focus lost

// Regex to match terminal response sequences we want to filter
// These include Device Attributes responses, cursor position reports, etc.
const TERMINAL_RESPONSE_REGEX = /\x1b\[\??[\d;]*[a-zA-Z]/g;

// For backwards compatibility
const DETACH_KEY = '\x1d';

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

// Rainbow colors for animated effect
const RAINBOW_COLORS = [
  '\x1b[91m', // bright red
  '\x1b[93m', // bright yellow
  '\x1b[92m', // bright green
  '\x1b[96m', // bright cyan
  '\x1b[94m', // bright blue
  '\x1b[95m', // bright magenta
];

/**
 * Apply rainbow gradient to text (static)
 */
function rainbowText(text: string, offset: number = 0): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const colorIndex = (i + offset) % RAINBOW_COLORS.length;
    result += RAINBOW_COLORS[colorIndex] + text[i];
  }
  return result + colors.reset;
}

/**
 * Animate rainbow text in place
 */
function animateRainbow(text: string, duration: number = 600): Promise<void> {
  return new Promise((resolve) => {
    let offset = 0;
    const startTime = Date.now();
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= duration) {
        // Final render
        process.stdout.write('\r' + rainbowText(text, offset) + '  ');
        resolve();
        return;
      }
      
      process.stdout.write('\r' + rainbowText(text, offset));
      offset = (offset + 1) % RAINBOW_COLORS.length;
      setTimeout(animate, 50);
    };
    
    animate();
  });
}

// Get terminal width (with fallback)
function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

// Create a full-width horizontal line
function fullWidthLine(char: string = '═', color: string = colors.dim): string {
  const width = getTerminalWidth();
  return `${color}${char.repeat(width)}${colors.reset}`;
}

// ASCII Art banner for AIC² (ANSI Shadow style - 8 lines with ASCII 2)
const AIC_BANNER = `
${colors.brightCyan} █████╗ ${colors.brightMagenta}██╗${colors.brightYellow} ██████╗ ${colors.dim}██████╗${colors.reset}
${colors.brightCyan}██╔══██╗${colors.brightMagenta}██║${colors.brightYellow}██╔════╝ ${colors.dim}╚════██╗${colors.reset}
${colors.brightCyan}██║  ██║${colors.brightMagenta}██║${colors.brightYellow}██║      ${colors.dim} █████╔╝${colors.reset}
${colors.brightCyan}███████║${colors.brightMagenta}██║${colors.brightYellow}██║      ${colors.dim}██╔═══╝${colors.reset}
${colors.brightCyan}██╔══██║${colors.brightMagenta}██║${colors.brightYellow}██║      ${colors.dim}███████╗${colors.reset}
${colors.brightCyan}██║  ██║${colors.brightMagenta}██║${colors.brightYellow}██║      ${colors.dim}╚══════╝${colors.reset}
${colors.brightCyan}██║  ██║${colors.brightMagenta}██║${colors.brightYellow}╚██████╗${colors.reset}
${colors.brightCyan}╚═╝  ╚═╝${colors.brightMagenta}╚═╝${colors.brightYellow} ╚═════╝${colors.reset}
`;

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

// AIC command definitions (single slash for AIC commands)
const AIC_COMMANDS = [
  { value: '/claude', name: `${rainbowText('/claude')}        Switch to Claude Code`, description: 'Switch to Claude Code (add -i for interactive)' },
  { value: '/gemini', name: `${rainbowText('/gemini', 1)}        Switch to Gemini CLI`, description: 'Switch to Gemini CLI (add -i for interactive)' },
  { value: '/i', name: `${rainbowText('/i', 2)}             Enter interactive mode`, description: 'Enter interactive mode (Ctrl+] or Ctrl+\\ to detach)' },
  { value: '/forward', name: `${rainbowText('/forward', 3)}       Forward last response`, description: 'Forward response: /forward [tool] [msg]' },
  { value: '/fwd', name: `${rainbowText('/fwd', 4)}            Forward (alias)`, description: 'Forward response: /fwd [tool] [msg]' },
  { value: '/history', name: `${rainbowText('/history', 4)}       Show conversation`, description: 'Show conversation history' },
  { value: '/status', name: `${rainbowText('/status', 5)}        Show running processes`, description: 'Show daemon status' },
  { value: '/default', name: `${rainbowText('/default', 0)}       Set default tool`, description: 'Set default tool: /default <claude|gemini>' },
  { value: '/help', name: `${rainbowText('/help', 1)}          Show help`, description: 'Show available commands' },
  { value: '/clear', name: `${rainbowText('/clear', 2)}         Clear sessions`, description: 'Clear sessions and history' },
  { value: '/quit', name: `${rainbowText('/quit', 3)}          Exit`, description: 'Exit AIC' },
  { value: '/cya', name: `${rainbowText('/cya', 4)}           Exit (alias)`, description: 'Exit AIC' },
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
  private startTime: number = 0;
  private warningShown = false;
  private readonly WARNING_THRESHOLD_MS = 60000; // 60 seconds
  private readonly WARNING_REPEAT_MS = 30000;    // Repeat every 30s after first warning
  private lastWarningTime: number = 0;
  private statusLine: string = '';
  private hasStatusLine = false;

  constructor(message: string = 'Thinking') {
    this.message = message;
  }

  start(): void {
    this.frameIndex = 0;
    this.startTime = Date.now();
    this.warningShown = false;
    this.lastWarningTime = 0;
    this.statusLine = '';
    this.hasStatusLine = false;

    // Clear any garbage on the current line before starting spinner
    process.stdout.write('\x1b[2K\r');
    process.stdout.write(`\n${SPINNER_FRAMES[0]} ${this.message} ...`);

    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      const elapsed = Date.now() - this.startTime;
      const elapsedSec = Math.floor(elapsed / 1000);

      // Build the spinner line with elapsed time
      const elapsedDisplay = elapsedSec > 0 ? ` (${elapsedSec}s)` : '';

      // Move cursor back and overwrite spinner line
      process.stdout.write(`\r${SPINNER_FRAMES[this.frameIndex]} ${this.message} ...${elapsedDisplay}   `);

      // If we have a status line, show it below
      if (this.statusLine) {
        // Move to next line, clear it, write status, move back up
        const termWidth = process.stdout.columns || 80;
        const truncatedStatus = this.statusLine.length > termWidth - 5
          ? this.statusLine.slice(0, termWidth - 8) + '...'
          : this.statusLine;
        process.stdout.write(`\n${colors.dim}  └─ ${truncatedStatus}${colors.reset}\x1b[K`);
        process.stdout.write('\x1b[1A'); // Move cursor back up
        this.hasStatusLine = true;
      }

      // Check if we should show a timeout warning
      if (elapsed >= this.WARNING_THRESHOLD_MS) {
        const timeSinceLastWarning = elapsed - this.lastWarningTime;
        if (!this.warningShown || timeSinceLastWarning >= this.WARNING_REPEAT_MS) {
          this.showTimeoutWarning(elapsedSec);
          this.warningShown = true;
          this.lastWarningTime = elapsed;
        }
      }
    }, 100); // Slightly slower to reduce flicker
  }

  /**
   * Update the status line shown below the spinner
   */
  setStatus(status: string): void {
    // Clean the status - remove ANSI codes and take last meaningful line
    const cleaned = stripAnsi(status).trim();
    if (cleaned.length > 0) {
      // Get last non-empty line
      const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
      if (lines.length > 0) {
        this.statusLine = lines[lines.length - 1].trim();
      }
    }
  }

  private showTimeoutWarning(elapsedSec: number): void {
    // Move down if we have status line, then print warning
    if (this.hasStatusLine) {
      process.stdout.write('\n');
    }
    process.stdout.write('\n');
    process.stdout.write(`${colors.yellow}⚠ Still working... (${elapsedSec}s)${colors.reset} - Press ${colors.bold}Ctrl+C${colors.reset} to cancel this request only\n`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      // Clear the spinner line and status line if present
      process.stdout.write('\r\x1b[K'); // Clear current line
      if (this.hasStatusLine) {
        process.stdout.write('\n\x1b[K\x1b[1A'); // Clear status line below
      }
      process.stdout.write('\r');
    }
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Session with persistent interactive mode support
 * - Regular messages: uses -p (print mode) with --continue/--resume
 * - Interactive mode: persistent PTY process, detach with Ctrl+]
 */
export class SDKSession {
  private isRunning = false;
  private activeTool: 'claude' | 'gemini';
  private conversationHistory: Message[] = [];

  // Adapter registry for tool lookup
  private registry: AdapterRegistry;

  // Persistent PTY managers - one per tool, lazy-spawned on first use
  private ptyManagers: Map<string, PersistentPtyManager> = new Map();

  // Working directory
  private cwd: string;

  // Readline interface for input with history
  private rl: Interface | null = null;
  private inputHistory: string[] = [];

  // Request state management
  private requestInProgress = false;

  constructor(registry: AdapterRegistry, cwd?: string) {
    this.registry = registry;
    this.cwd = cwd || process.cwd();
    // Load default tool from config (or env var)
    this.activeTool = getDefaultTool() as 'claude' | 'gemini';
  }

  /**
   * Get or create a PersistentPtyManager for a tool.
   * Lazy-spawns the PTY on first use.
   * @param tool The tool name
   * @param waitForReady If false, returns immediately after spawning (for interactive mode)
   */
  private async getOrCreateManager(tool: string, waitForReady: boolean = true): Promise<PersistentPtyManager> {
    let manager = this.ptyManagers.get(tool);

    if (!manager || manager.isDead()) {
      const adapter = this.registry.get(tool);
      if (!adapter) {
        throw new Error(`Unknown tool: ${tool}`);
      }

      manager = new PersistentPtyManager({
        name: adapter.name,
        command: adapter.name,
        args: adapter.getPersistentArgs(),
        promptPattern: adapter.promptPattern,
        idleTimeout: adapter.idleTimeout,
        cleanResponse: (raw) => adapter.cleanResponse(raw),
        color: adapter.color,
        displayName: adapter.displayName,
      });

      manager.setCallbacks({
        onExit: (exitCode) => {
          console.log(`\n${colors.dim}${adapter.displayName} exited (code ${exitCode})${colors.reset}`);
        },
        onStateChange: (state) => {
          // Could add state change handling here if needed
        },
      });

      this.ptyManagers.set(tool, manager);

      // Spawn the PTY (optionally wait for ready)
      await manager.spawn(this.cwd, waitForReady);
    }

    return manager;
  }

  async start(): Promise<void> {
    // Ensure cursor is visible
    process.stdout.write(cursor.show + cursor.blockBlink);

    const width = getTerminalWidth();

    // Fast availability check using 'which' command (~50ms total vs ~4s for version checks)
    const [claudeAvailable, geminiAvailable] = await Promise.all([
      commandExists('claude'),
      commandExists('gemini')
    ]);
    const availableCount = (claudeAvailable ? 1 : 0) + (geminiAvailable ? 1 : 0);

    // Handle no tools available
    if (availableCount === 0) {
      console.log('');
      console.log(`${colors.red}✗ No AI tools found!${colors.reset}`);
      console.log('');
      console.log(`${colors.dim}AIC² bridges multiple AI CLI tools. Please install both:${colors.reset}`);
      console.log('');
      console.log(`  ${colors.brightCyan}Claude Code${colors.reset}: npm install -g @anthropic-ai/claude-code`);
      console.log(`  ${colors.brightMagenta}Gemini CLI${colors.reset}:  npm install -g @google/gemini-cli`);
      console.log('');
      process.exit(1);
    }

    // Handle only one tool available
    if (availableCount === 1) {
      const availableTool = claudeAvailable ? 'Claude Code' : 'Gemini CLI';
      const availableCmd = claudeAvailable ? 'claude' : 'gemini';
      const missingTool = claudeAvailable ? 'Gemini CLI' : 'Claude Code';
      const missingInstall = claudeAvailable 
        ? 'npm install -g @google/gemini-cli'
        : 'npm install -g @anthropic-ai/claude-code';
      
      console.log('');
      console.log(`${colors.yellow}⚠ Only ${availableTool} found${colors.reset}`);
      console.log('');
      console.log(`${colors.dim}AIC² bridges multiple AI tools - you need both installed.${colors.reset}`);
      console.log(`${colors.dim}Install ${missingTool}:${colors.reset}`);
      console.log(`  ${missingInstall}`);
      console.log('');
      console.log(`${colors.dim}Or use ${availableTool} directly:${colors.reset} ${availableCmd}`);
      console.log('');
      process.exit(1);
    }
    
    // Clear screen and show splash
    console.clear();
    
    // Top separator
    console.log('');
    console.log(fullWidthLine('═'));
    console.log('');
    
    // Banner with title and connected tools on the right side
    const bannerLines = AIC_BANNER.trim().split('\n');
    const titleLines = [
      `${colors.brightCyan}A${colors.brightMagenta}I${colors.reset} ${colors.brightYellow}C${colors.white}ode${colors.reset} ${colors.brightYellow}C${colors.white}onnect${colors.reset}  ${colors.dim}v${VERSION}${colors.reset}`,
      '',
      `${colors.dim}Connected Tools:${colors.reset}`,
      claudeAvailable
        ? `✅ ${colors.brightCyan}Claude Code${colors.reset} ${colors.dim}ready${colors.reset}`
        : `❌ ${colors.dim}Claude Code (not found)${colors.reset}`,
      geminiAvailable
        ? `✅ ${colors.brightMagenta}Gemini CLI${colors.reset} ${colors.dim}ready${colors.reset}`
        : `❌ ${colors.dim}Gemini CLI (not found)${colors.reset}`,
      '',
      `${colors.dim}📁 ${this.cwd}${colors.reset}`,
    ];
    
    // Print banner and title side by side, centered
    const maxLines = Math.max(bannerLines.length, titleLines.length);
    const bannerWidth = 30; // Approximate width of banner
    const gap = 10;
    const maxTitleWidth = Math.max(...titleLines.map(l => stripAnsiLength(l)));
    const totalContentWidth = bannerWidth + gap + maxTitleWidth;
    const leftPadding = Math.max(2, Math.floor((width - totalContentWidth) / 2));
    
    for (let i = 0; i < maxLines; i++) {
      const bannerLine = bannerLines[i] || '';
      const titleLine = titleLines[i] || '';
      console.log(`${' '.repeat(leftPadding)}${bannerLine}${' '.repeat(Math.max(0, bannerWidth - stripAnsiLength(bannerLine) + gap))}${titleLine}`);
    }
    
    console.log('');
    console.log(fullWidthLine('─'));
    console.log('');
    
    // Commands in a wider layout (single slash = AIC commands, double slash = tool commands via interactive mode)
    const commandsLeft = [
      `  ${rainbowText('/claude')}        Switch to Claude Code ${colors.dim}(-i for interactive)${colors.reset}`,
      `  ${rainbowText('/gemini', 1)}        Switch to Gemini CLI ${colors.dim}(-i for interactive)${colors.reset}`,
      `  ${rainbowText('/i', 2)}             Enter interactive mode`,
      `  ${rainbowText('/forward', 3)}       Forward response ${colors.dim}[tool] [msg]${colors.reset}`,
      `  ${rainbowText('/forwardi', 4)}      Forward + interactive ${colors.dim}(or -i flag)${colors.reset}`,
    ];

    const commandsRight = [
      `  ${rainbowText('/history', 5)}       Show conversation`,
      `  ${rainbowText('/status', 0)}        Show running processes`,
      `  ${rainbowText('/clear', 1)}         Clear sessions`,
      `  ${rainbowText('/quit', 2)}          Exit ${colors.dim}(or /cya)${colors.reset}`,
      '',
    ];
    
    // Print commands side by side if terminal is wide enough
    if (width >= 100) {
      const colWidth = Math.floor(width / 2) - 5;
      for (let i = 0; i < commandsLeft.length; i++) {
        const left = commandsLeft[i] || '';
        const right = commandsRight[i] || '';
        const leftPadded = left + ' '.repeat(Math.max(0, colWidth - stripAnsiLength(left)));
        console.log(`${leftPadded}${right}`);
      }
    } else {
      // Single column for narrow terminals
      commandsLeft.forEach(cmd => console.log(cmd));
      commandsRight.forEach(cmd => console.log(cmd));
    }
    
    console.log('');
    
    // Tips section
    console.log(`  ${colors.dim}💡 ${colors.brightYellow}//command${colors.dim} opens interactive mode & sends the command. ${colors.white}Use ${colors.brightYellow}Ctrl+]${colors.white}, ${colors.brightYellow}Ctrl+\\${colors.white}, or ${colors.brightYellow}Esc Esc${colors.white} to return to aic²${colors.reset}`);
    console.log(`  ${colors.dim}💡 ${colors.brightYellow}Tab${colors.dim}: autocomplete   ${colors.brightYellow}↑/↓${colors.dim}: history${colors.reset}`);
    console.log('');
    
    // Show active tool with full width separator
    const toolColor = this.activeTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const toolName = this.activeTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    console.log(fullWidthLine('═'));
    console.log(`  ${colors.green}●${colors.reset} Active: ${toolColor}${toolName}${colors.reset}`);
    console.log(fullWidthLine('─'));
    console.log('');

    this.isRunning = true;
    await this.runLoop();
  }

  private getPrompt(): string {
    const toolColor = this.activeTool === 'claude' ? colors.brightCyan : colors.brightMagenta;
    const toolName = this.activeTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
    return `${toolColor}❯ ${toolName}${colors.reset} ${colors.dim}→${colors.reset} `;
  }

  /**
   * Tab completion for / commands
   */
  private completer(line: string): CompleterResult {
    const commands = ['/claude', '/gemini', '/i', '/forward', '/fwd', '/forwardi', '/fwdi', '/history', '/status', '/default', '/help', '/clear', '/quit', '/cya'];
    
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

    // Handle Ctrl+C gracefully - exit the application
    this.rl.on('SIGINT', () => {
      if (this.requestInProgress) {
        console.log(`\n${colors.yellow}Request in progress - please wait or use /i to interact${colors.reset}`);
        return;
      }

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

      // Handle double slash - enter interactive mode and send the command
      // e.g., //status -> enters interactive mode, sends /status, user stays in control
      if (trimmed.startsWith('//')) {
        const slashCmd = trimmed.slice(1); // e.g., "/status"
        const toolName = this.activeTool === 'claude' ? 'Claude Code' : 'Gemini CLI';
        
        // Show rainbow "Entering Interactive Mode" message
        await animateRainbow(`Entering Interactive Mode for ${toolName}...`, 500);
        process.stdout.write('\n');
        
        await this.enterInteractiveModeWithCommand(slashCmd);
        continue;
      }

      // Handle AIC meta commands (single slash)
      if (trimmed.startsWith('/')) {
        // Readline already echoed the command - just process it, no extra output
        await this.handleMetaCommand(trimmed.slice(1));
        continue;
      }

      // Send regular input to active tool
      await this.sendToTool(trimmed);
    }
  }

  private readInput(): Promise<string> {
    return new Promise((resolve) => {
      // Update prompt in case tool changed
      this.rl?.setPrompt(this.getPrompt());
      this.rl?.prompt();
      
      const lineHandler = (line: string) => {
        // Filter out terminal garbage that may have leaked into the input
        let cleaned = line
          .replace(/\x1b\[I/g, '')
          .replace(/\x1b\[O/g, '')
          .replace(/\^\[\[I/g, '')
          .replace(/\^\[\[O/g, '')
          .replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
          
        // AGGRESSIVE STRIP: Remove Device Attribute response suffixes
        // e.g. "/cya;1;2;...;52c" -> "/cya"
        // Pattern: semicolon followed by numbers/semicolons ending in c at the end of string
        cleaned = cleaned.replace(/;[\d;]+c$/, '');
        
        // Also strip if it's just the garbage on its own line
        cleaned = cleaned.replace(/^\d*u?[\d;]+c$/, '');
        
        cleaned = cleaned.trim();
          
        // If the line was ONLY garbage (and now empty), ignore it
        if (line.length > 0 && cleaned.length === 0) {
          this.rl?.prompt();
          return;
        }
        
        // Valid input
        this.rl?.removeListener('line', lineHandler);
        resolve(cleaned);
      };
      
      this.rl?.on('line', lineHandler);
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

      case 'claude': {
        const hasInteractive = parts.slice(1).includes('-i');
        this.activeTool = 'claude';
        console.log(`${colors.green}●${colors.reset} Switched to ${colors.brightCyan}Claude Code${colors.reset}`);
        if (hasInteractive) {
          await this.enterInteractiveMode();
        }
        break;
      }

      case 'gemini': {
        const hasInteractive = parts.slice(1).includes('-i');
        this.activeTool = 'gemini';
        console.log(`${colors.green}●${colors.reset} Switched to ${colors.brightMagenta}Gemini CLI${colors.reset}`);
        if (hasInteractive) {
          await this.enterInteractiveMode();
        }
        break;
      }

      case 'forward':
      case 'fwd': {
        // Check for -i flag for interactive mode
        const forwardArgs = parts.slice(1);
        const hasInteractiveFlag = forwardArgs.includes('-i');
        const argsWithoutFlag = forwardArgs.filter(a => a !== '-i').join(' ');
        await this.handleForward(argsWithoutFlag, hasInteractiveFlag);
        break;
      }

      case 'forwardi':
      case 'fwdi':
        // Forward and enter interactive mode
        await this.handleForward(parts.slice(1).join(' '), true);
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
        this.conversationHistory = [];
        console.log('Sessions and history cleared.');
        break;

      case 'default':
        const toolArg = parts[1];
        if (toolArg) {
          // Set new default
          const result = setDefaultTool(toolArg);
          if (result.success) {
            console.log(`${colors.green}✓${colors.reset} ${result.message}`);
          } else {
            console.log(`${colors.red}✗${colors.reset} ${result.message}`);
          }
        } else {
          // Show current default
          const currentDefault = getDefaultTool();
          console.log(`${colors.dim}Current default tool:${colors.reset} ${colors.brightYellow}${currentDefault}${colors.reset}`);
          console.log(`${colors.dim}Usage:${colors.reset} /default <claude|gemini>`);
        }
        break;

      case 'help':
      case '?':
        this.showHelp();
        break;

      default:
        console.log(`${colors.red}✗${colors.reset} Unknown AIC command: ${colors.brightYellow}/${command}${colors.reset}`);
        console.log(`${colors.dim}  Type ${colors.brightYellow}/help${colors.dim} to see available commands.${colors.reset}`);
        console.log(`${colors.dim}  To send /${command} to the tool, use ${colors.brightYellow}//${command}${colors.reset}`);
    }
  }

  private showHelp(): void {
    console.log('');
    console.log(`${colors.brightCyan}A${colors.brightMagenta}I${colors.reset} ${colors.brightYellow}C${colors.white}ode${colors.reset} ${colors.brightYellow}C${colors.white}onnect${colors.reset}² ${colors.dim}- Commands${colors.reset}`);
    console.log('');
    console.log(`${colors.white}Session Commands:${colors.reset}`);
    console.log(`  ${rainbowText('/claude')}        Switch to Claude Code ${colors.dim}(add -i for interactive)${colors.reset}`);
    console.log(`  ${rainbowText('/gemini')}        Switch to Gemini CLI ${colors.dim}(add -i for interactive)${colors.reset}`);
    console.log(`  ${rainbowText('/i')}             Enter interactive mode ${colors.dim}(Ctrl+] or Ctrl+\\ to detach)${colors.reset}`);
    console.log(`  ${rainbowText('/forward')}       Forward last response ${colors.dim}[tool] [msg]${colors.reset}`);
    console.log(`  ${rainbowText('/forward -i')}    Forward and enter interactive mode`);
    console.log(`  ${rainbowText('/forwardi')}      Same as /forward -i ${colors.dim}(alias: /fwdi)${colors.reset}`);
    console.log(`  ${rainbowText('/history')}       Show conversation history`);
    console.log(`  ${rainbowText('/status')}        Show running processes`);
    console.log(`  ${rainbowText('/default')}       Set default tool ${colors.dim}<claude|gemini>${colors.reset}`);
    console.log(`  ${rainbowText('/clear')}         Clear sessions and history`);
    console.log(`  ${rainbowText('/help')}          Show this help`);
    console.log(`  ${rainbowText('/quit')}          Exit ${colors.dim}(or /cya)${colors.reset}`);
    console.log('');
    console.log(`${colors.white}Tool Commands:${colors.reset}`);
    console.log(`  ${colors.brightYellow}//command${colors.reset}        Send /command to the active tool`);
    console.log(`  ${colors.dim}                 Opens interactive mode, sends command, Ctrl+] or Ctrl+\\ to return${colors.reset}`);
    console.log('');
    console.log(`${colors.white}Tips:${colors.reset}`);
    console.log(`  ${colors.dim}•${colors.reset} ${colors.brightYellow}Tab${colors.reset}            Autocomplete commands`);
    console.log(`  ${colors.dim}•${colors.reset} ${colors.brightYellow}↑/↓${colors.reset}            Navigate history`);
    console.log(`  ${colors.dim}•${colors.reset} ${colors.brightYellow}Ctrl+]${colors.reset}, ${colors.brightYellow}Ctrl+\\${colors.reset}, ${colors.brightYellow}Ctrl+^${colors.reset}, or ${colors.brightYellow}Ctrl+_${colors.reset}  Detach from interactive mode`);
    console.log(`  ${colors.dim}•${colors.reset} ${colors.brightYellow}Esc Esc${colors.reset}        Detach (press Escape twice quickly)`);
    console.log('');
  }

  /**
   * Send a message silently (no response display).
   * Used for /fwdi to send via print mode without showing output,
   * then user sees response in interactive mode.
   */
  private async sendToToolSilent(message: string, statusMessage: string): Promise<boolean> {
    if (this.requestInProgress) {
      console.log(`${colors.yellow}⏳ Please wait for the current request to finish${colors.reset}`);
      return false;
    }

    this.requestInProgress = true;

    // Record user message
    this.conversationHistory.push({
      tool: this.activeTool,
      role: 'user',
      content: message,
    });

    while (this.conversationHistory.length > MAX_HISTORY_SIZE) {
      this.conversationHistory.shift();
    }

    const adapter = this.registry.get(this.activeTool);
    const toolColor = adapter?.color || colors.white;

    // Custom spinner with status message
    const spinner = new Spinner(`${toolColor}${statusMessage}${colors.reset}`);
    spinner.start();

    try {
      // Kill any existing PTY for this tool
      const existingManager = this.ptyManagers.get(this.activeTool);
      if (existingManager && !existingManager.isDead()) {
        existingManager.kill(true);
        this.ptyManagers.delete(this.activeTool);
      }

      if (!adapter) {
        throw new Error(`Unknown tool: ${this.activeTool}`);
      }

      const response = await adapter.send(message, {
        cwd: this.cwd,
        continueSession: true,
        timeout: REQUEST_TIMEOUT_MS,
      });

      spinner.stop();

      // Record assistant response (but don't display it)
      this.conversationHistory.push({
        tool: this.activeTool,
        role: 'assistant',
        content: response,
      });

      while (this.conversationHistory.length > MAX_HISTORY_SIZE) {
        this.conversationHistory.shift();
      }

      return true;
    } catch (error) {
      spinner.stop();
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n${colors.red}Error:${colors.reset} ${errorMessage}\n`);
      this.conversationHistory.pop();
      return false;
    } finally {
      this.requestInProgress = false;
    }
  }

  private async sendToTool(message: string): Promise<void> {
    // Prevent concurrent requests
    if (this.requestInProgress) {
      console.log(`${colors.yellow}⏳ Please wait for the current request to finish${colors.reset}`);
      return;
    }

    this.requestInProgress = true;

    // Record user message
    this.conversationHistory.push({
      tool: this.activeTool,
      role: 'user',
      content: message,
    });

    // Enforce history size limit
    while (this.conversationHistory.length > MAX_HISTORY_SIZE) {
      this.conversationHistory.shift();
    }

    const adapter = this.registry.get(this.activeTool);
    const toolColor = adapter?.color || colors.white;
    const toolName = adapter?.displayName || this.activeTool;

    // Start spinner
    const spinner = new Spinner(`${toolColor}${toolName}${colors.reset} is thinking`);
    spinner.start();

    try {
      // Kill any existing PTY for this tool to avoid session conflicts
      // This ensures /i will start fresh with --continue from the latest session
      const existingManager = this.ptyManagers.get(this.activeTool);
      if (existingManager && !existingManager.isDead()) {
        existingManager.kill(true); // Silent kill - don't show "exited" message
        this.ptyManagers.delete(this.activeTool);
      }

      // Use adapter's send method (runs in print mode with -p flag)
      const adapter = this.registry.get(this.activeTool);
      if (!adapter) {
        throw new Error(`Unknown tool: ${this.activeTool}`);
      }

      const response = await adapter.send(message, {
        cwd: this.cwd,
        continueSession: true,
        timeout: REQUEST_TIMEOUT_MS,
      });

      spinner.stop();

      // Render the response
      console.log('');
      if (response) {
        const rendered = marked.parse(response) as string;
        process.stdout.write(rendered);
      }
      console.log('');

      // Record assistant response
      this.conversationHistory.push({
        tool: this.activeTool,
        role: 'assistant',
        content: response,
      });

      // Enforce history size limit again after adding response
      while (this.conversationHistory.length > MAX_HISTORY_SIZE) {
        this.conversationHistory.shift();
      }
    } catch (error) {
      spinner.stop();
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n${colors.red}Error:${colors.reset} ${errorMessage}\n`);

      // Remove the user message if failed
      this.conversationHistory.pop();
    } finally {
      this.requestInProgress = false;
    }
  }

  /**
   * Enter full interactive mode with the active tool.
   * Uses the unified PersistentPtyManager for session continuity.
   * Press Ctrl+] to detach (PTY keeps running)
   */
  private async enterInteractiveMode(): Promise<void> {
    const adapter = this.registry.get(this.activeTool);
    const toolName = adapter?.displayName || this.activeTool;
    const toolColor = adapter?.color || colors.white;

    // Check if this is a first launch (no existing manager)
    const existingManager = this.ptyManagers.get(this.activeTool);
    const isFirstLaunch = !existingManager || existingManager.isDead();

    // Get or create the persistent PTY manager (don't wait for ready - user sees startup)
    const manager = await this.getOrCreateManager(this.activeTool, false);
    const isReattach = manager.isUserAttached() === false && manager.getState() !== PtyState.DEAD;

    // Close readline completely to prevent interference with raw input
    // (pause() is not enough - readline continues to echo input)
    this.rl?.close();
    this.rl = null;

    // Show rainbow "Entering Interactive Mode" message
    await animateRainbow(`Entering Interactive Mode for ${toolName}...`, 500);
    process.stdout.write('\n');

    if (isReattach && manager.getOutputBuffer().length > 0) {
      console.log(`${colors.green}↩${colors.reset} Re-attaching to ${toolColor}${toolName}${colors.reset}...`);
      // Replay buffer to restore screen state
      process.stdout.write('\x1b[2J\x1b[H'); // Clear screen
      const buffer = manager.getOutputBuffer();
      const filteredBuffer = buffer.split(FOCUS_IN_SEQ).join('').split(FOCUS_OUT_SEQ).join('');
      process.stdout.write(filteredBuffer);
    } else if (isFirstLaunch) {
      console.log(`${colors.dim}💡 First launch of ${toolName} may take a few seconds to initialize...${colors.reset}`);
    }
    console.log(`${colors.dim}Press ${colors.brightYellow}Ctrl+]${colors.dim} or ${colors.brightYellow}Ctrl+\\${colors.dim} to detach${colors.reset}\n`);

    // Mark as attached - output will now flow to stdout
    manager.attach();

    return this.runInteractiveSession(manager, toolName, toolColor);
  }

  /**
   * Enter interactive mode and automatically send a slash command
   * Uses v1.0.1 proven approach: detect new vs reattach, proper delay, char-by-char typing
   */
  private async enterInteractiveModeWithCommand(slashCommand: string): Promise<void> {
    const adapter = this.registry.get(this.activeTool);
    const toolName = adapter?.displayName || this.activeTool;
    const toolColor = adapter?.color || colors.white;

    // Check if manager exists BEFORE getting (to detect new spawn vs reattach)
    const existingManager = this.ptyManagers.get(this.activeTool);
    const isReattach = existingManager !== undefined && !existingManager.isDead();

    // Get or create the persistent PTY manager (don't wait - user sees startup)
    const manager = await this.getOrCreateManager(this.activeTool, false);

    // Close readline completely to prevent interference with raw input
    this.rl?.close();
    this.rl = null;

    console.log(`${colors.dim}Sending ${colors.brightYellow}${slashCommand}${colors.dim}... Press ${colors.brightYellow}Ctrl+]${colors.dim} or ${colors.brightYellow}Ctrl+\\${colors.dim} to return${colors.reset}\n`);

    // Mark as attached
    manager.attach();

    // For reattach, send quickly. For new process, use adapter's startup delay.
    const sendDelay = isReattach ? 100 : (adapter?.startupDelay || 2500);

    // Send command after appropriate delay, typing char by char for reliability
    setTimeout(() => {
      let i = 0;
      const fullCommand = slashCommand + '\r';
      const typeNextChar = () => {
        if (i < fullCommand.length) {
          manager.write(fullCommand[i]);
          i++;
          setTimeout(typeNextChar, 20);
        }
      };
      typeNextChar();
    }, sendDelay);

    return this.runInteractiveSession(manager, toolName, toolColor);
  }

  /**
   * Common interactive session logic - handles stdin forwarding and detach keys
   */
  private runInteractiveSession(
    manager: PersistentPtyManager,
    toolName: string,
    toolColor: string
  ): Promise<void> {
    const pty = manager.getPty();
    if (!pty) {
      return Promise.reject(new Error('PTY not available'));
    }

    return new Promise((resolve) => {
      // Handle resize
      const onResize = () => {
        const p = manager.getPty();
        if (p) {
          p.resize(process.stdout.columns || 80, process.stdout.rows || 24);
        }
      };
      process.stdout.on('resize', onResize);

      // Set up stdin forwarding
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      let detached = false;
      let lastEscapeTime = 0;
      const debugKeys = process.env.AIC_DEBUG === '1';

      let onStdinData: ((data: Buffer) => void) | null = null;

      const performDetach = () => {
        if (detached) return;
        detached = true;

        if (onStdinData) {
          process.stdin.removeListener('data', onStdinData);
        }

        // Capture the output buffer before detaching for /fwd support
        const outputBuffer = manager.getOutputBuffer();

        manager.detach();
        cleanup();

        // Extract and save the assistant's response to conversation history
        // This enables /fwd to forward responses from interactive sessions
        if (outputBuffer && outputBuffer.length > 0) {
          const adapter = this.registry.get(this.activeTool);
          if (adapter) {
            const cleanedResponse = adapter.cleanResponse(outputBuffer);
            // Only add if there's meaningful content (not just prompts/empty)
            if (cleanedResponse && cleanedResponse.length > 20) {
              this.conversationHistory.push({
                tool: this.activeTool,
                role: 'assistant',
                content: cleanedResponse,
              });
              // Enforce history size limit
              while (this.conversationHistory.length > MAX_HISTORY_SIZE) {
                this.conversationHistory.shift();
              }
            }
          }
        }

        process.stdout.write('\x1b[2K\r');
        console.log(`\n\n${colors.yellow}⏸${colors.reset} Detached from ${toolColor}${toolName}${colors.reset} ${colors.dim}(still running)${colors.reset}`);
        console.log(`${colors.dim}Use ${colors.brightYellow}/i${colors.dim} to re-attach${colors.reset}\n`);
        resolve();
      };

      onStdinData = (data: Buffer) => {
        let str = data.toString();

        if (debugKeys) {
          const hexBytes = Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
          console.log(`\n[DEBUG] Received ${data.length} bytes: ${hexBytes}`);
        }

        // Filter focus sequences
        if (str === FOCUS_IN_SEQ || str === FOCUS_OUT_SEQ) {
          return;
        }
        str = str.split(FOCUS_IN_SEQ).join('').split(FOCUS_OUT_SEQ).join('');

        // Filter terminal response sequences (DA responses, keyboard enhancement, etc.)
        // Full sequences: ESC[?...c, ESC[>...c, ESC[?...u
        // These must be filtered BEFORE forwarding to PTY to prevent echo
        str = str
          .replace(/\x1b\[\?[\d;]*[uc]/g, '')   // ESC[?...c or ESC[?...u
          .replace(/\x1b\[>[\d;]*c/g, '')       // ESC[>...c
          .replace(/\x1b\[[\d;]*u/g, '');       // ESC[...u (CSI u)

        if (str.length === 0) return;

        // Check for CSI u detach sequences
        for (const seq of CSI_U_DETACH_SEQS) {
          if (str === seq || str.includes(seq)) {
            performDetach();
            return;
          }
        }

        // Check for detach keys
        for (let i = 0; i < data.length; i++) {
          const byte = data[i];
          if (byte === DETACH_KEYS.CTRL_BRACKET ||
              byte === DETACH_KEYS.CTRL_BACKSLASH ||
              byte === DETACH_KEYS.CTRL_CARET ||
              byte === DETACH_KEYS.CTRL_UNDERSCORE) {
            performDetach();
            return;
          }
        }

        // Double escape detection
        if (data.length >= 2) {
          for (let i = 0; i < data.length - 1; i++) {
            if (data[i] === DETACH_KEYS.ESCAPE && data[i + 1] === DETACH_KEYS.ESCAPE) {
              performDetach();
              return;
            }
          }
        }

        // Single escape with timing
        const isSingleEscape = data.length === 1 && data[0] === DETACH_KEYS.ESCAPE;
        if (isSingleEscape) {
          const now = Date.now();
          if (now - lastEscapeTime < 500) {
            performDetach();
            return;
          }
          lastEscapeTime = now;
        } else {
          lastEscapeTime = 0;
        }

        // Forward to PTY
        manager.write(str);
      };

      process.stdin.on('data', onStdinData);

      // Cleanup function
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;

        process.stdin.removeListener('data', onStdinData);
        process.stdout.removeListener('resize', onResize);

        process.stdout.write('\x1b[2K\r');
        process.stdout.write('\x1b[?1004l'); // Disable focus reporting
        process.stdout.write('\x1b[?2004l'); // Disable bracketed paste
        process.stdout.write('\x1b[>0u');    // Reset keyboard enhancement
        process.stdout.write('\x1b[?25h');   // Show cursor

        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }

        this.rl?.close();
        this.setupReadline();
      };
    });
  }

  private showStatus(): void {
    console.log('');

    const statusLines = AVAILABLE_TOOLS.map(tool => {
      const manager = this.ptyManagers.get(tool.name);
      const icon = tool.name === 'claude' ? '◆' : '◇';

      // Check if we have conversation history for this tool
      const hasHistory = this.conversationHistory.some(m => m.tool === tool.name);

      let status: string;
      if (manager && !manager.isDead()) {
        const state = manager.getState();
        const pty = manager.getPty();
        const pid = pty?.pid || 'unknown';

        if (state === PtyState.ATTACHED) {
          status = `${colors.green}● Attached${colors.reset} (PID: ${pid})`;
        } else if (state === PtyState.PROCESSING) {
          status = `${colors.yellow}● Processing${colors.reset} (PID: ${pid})`;
        } else {
          status = `${colors.green}● Running${colors.reset} (PID: ${pid})`;
        }
      } else {
        status = `${colors.dim}○ Stopped${colors.reset}`;
      }

      const historyNote = hasHistory ? `${colors.dim}(has history)${colors.reset}` : '';
      return `${tool.color}${icon} ${tool.displayName.padEnd(12)}${colors.reset} ${status}  ${historyNote}`;
    });

    // Add current request status
    if (this.requestInProgress) {
      statusLines.push('');
      statusLines.push(`${colors.yellow}⏳ Request in progress${colors.reset}`);
    }

    console.log(drawBox(statusLines, 62));
    console.log('');
  }

  private async handleForward(argsString: string, interactive: boolean = false): Promise<void> {
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
        console.log(`  ${colors.brightGreen}/forward${colors.reset} <${otherTools.join('|')}> [message]`);
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
    console.log(`${colors.green}↗${colors.reset} Forwarding from ${sourceColor}${sourceDisplayName}${colors.reset} → ${targetColor}${targetDisplayName}${colors.reset}${interactive ? ` ${colors.dim}(interactive)${colors.reset}` : ''}`);
    console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

    // Build forward prompt
    let forwardPrompt = `Another AI assistant (${sourceDisplayName}) provided this response. Please review and share your thoughts:\n\n---\n${lastResponse.content}\n---`;

    if (additionalMessage.trim()) {
      forwardPrompt += `\n\nAdditional context: ${additionalMessage.trim()}`;
    }

    if (interactive) {
      // Silent send: show status spinner, don't display response
      // User will see the response when interactive mode opens
      const statusMessage = `Sending to ${targetDisplayName}... Interactive mode will launch shortly`;
      const success = await this.sendToToolSilent(forwardPrompt, statusMessage);

      if (success) {
        console.log(`\n${colors.dim}Launching interactive mode...${colors.reset}`);
        await this.enterInteractiveMode();
      }
    } else {
      // Regular /fwd: show spinner and display response
      console.log(`${targetColor}${targetDisplayName} responds:${colors.reset}`);
      await this.sendToTool(forwardPrompt);
    }
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
    // Kill any running PTY managers
    for (const [tool, manager] of this.ptyManagers) {
      if (!manager.isDead()) {
        console.log(`Stopping ${tool}...`);
        manager.kill();
      }
    }
    this.ptyManagers.clear();
  }
}

export async function startSDKSession(registry: AdapterRegistry): Promise<void> {
  const session = new SDKSession(registry);
  await session.start();
}
