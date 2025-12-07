import { spawn, SpawnOptions } from 'child_process';
import * as pty from 'node-pty';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command and capture its output (non-interactive)
 */
export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin - we're not sending input
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
    
    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

export interface PtyRunResult {
  output: string;
  exitCode: number;
}

/**
 * Run a command interactively using a PTY (pseudo-terminal)
 * - Preserves colors and formatting
 * - Allows user interaction (approve commands, answer prompts)
 * - Streams output in real-time
 * - Captures output for forwarding
 */
export async function runCommandPty(
  command: string,
  args: string[],
  options: { cwd?: string; keepStdinOpen?: boolean; initialInput?: string } = {}
): Promise<PtyRunResult> {
  return new Promise((resolve, reject) => {
    let output = '';
    
    // Get terminal size
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    
    // Remember stdin state before PTY
    const wasRawMode = process.stdin.isTTY && (process.stdin as any).isRaw;
    
    // Spawn PTY
    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd || process.cwd(),
      env: process.env as { [key: string]: string },
    });
    
    // Handle terminal resize
    const onResize = () => {
      ptyProcess.resize(
        process.stdout.columns || 80,
        process.stdout.rows || 24
      );
    };
    process.stdout.on('resize', onResize);
    
    // Stream output to terminal AND capture it
    ptyProcess.onData((data) => {
      output += data;
      process.stdout.write(data);
    });
    
    // Send initial input if provided (e.g., for slash commands)
    if (options.initialInput) {
      // Small delay to let the process start
      setTimeout(() => {
        ptyProcess.write(options.initialInput!);
      }, 100);
    }
    
    // Forward user input to PTY
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    
    const onStdinData = (data: Buffer) => {
      ptyProcess.write(data.toString());
    };
    process.stdin.on('data', onStdinData);
    
    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      // Cleanup
      process.stdin.removeListener('data', onStdinData);
      process.stdout.removeListener('resize', onResize);
      
      // Restore stdin state
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRawMode);
      }
      
      // Don't pause stdin if caller wants to keep it open (e.g., interactive session)
      if (!options.keepStdinOpen) {
        process.stdin.pause();
      }
      
      resolve({
        output,
        exitCode,
      });
    });
  });
}

/**
 * Check if a command exists in PATH
 * Uses 'where' on Windows, 'which' on Unix-like systems
 */
export async function commandExists(command: string): Promise<boolean> {
  // Security: Validate command name to prevent injection
  // Only allow alphanumeric, dash, and underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }

  try {
    // Use 'where' on Windows, 'which' on Unix-like systems
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = await runCommand(whichCommand, [command]);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Strip ANSI escape codes from a string
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format a tool response for display
 */
export function formatResponse(toolName: string, response: string): string {
  const separator = '─'.repeat(60);
  return `\n${separator}\n[${toolName}]\n${separator}\n${response}\n${separator}\n`;
}

/**
 * Get the version of a CLI tool asynchronously
 * Uses runCommand to avoid blocking the main thread
 */
export async function getToolVersionAsync(command: string): Promise<string | null> {
  try {
    const { stdout, stderr, exitCode } = await runCommand(command, ['-v']);
    if (exitCode !== 0) return null;

    // Some tools output version to stderr
    const output = (stdout || stderr).trim();
    if (!output) return null;

    // Extract version number (first line, clean up)
    const firstLine = output.split('\n')[0];
    // Handle formats like "2.0.59 (Claude Code)" or just "0.19.1"
    const version = firstLine.split(' ')[0];
    return version || null;
  } catch {
    return null;
  }
}
