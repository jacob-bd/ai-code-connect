#!/usr/bin/env node

import { Command } from 'commander';
import { AdapterRegistry, ClaudeAdapter, GeminiAdapter } from './adapters/index.js';
import { SessionManager } from './session.js';
import { loadConfig } from './config.js';
import { startSDKSession } from './sdk-session.js';

const program = new Command();

// Initialize adapters
const registry = new AdapterRegistry();
registry.register(new ClaudeAdapter());
registry.register(new GeminiAdapter());

// Load config
const config = loadConfig();

// Initialize session manager and load any existing session
const session = new SessionManager(registry, config.defaultTool);
session.load(); // Load persisted session from disk

program
  .name('aic')
  .description('AI Code Connect - Bridge Claude Code and Gemini CLI')
  .version('1.0.0');

// Ask command - send a one-shot prompt to a tool
program
  .command('ask <tool> <prompt>')
  .description('Send a prompt to a specific AI tool (claude or gemini)')
  .option('-c, --cwd <dir>', 'Working directory for the tool')
  .action(async (tool: string, prompt: string, options: { cwd?: string }) => {
    try {
      const adapter = registry.get(tool);
      if (!adapter) {
        console.error(`Unknown tool: ${tool}. Available: ${registry.getNames().join(', ')}`);
        process.exit(1);
      }
      
      if (!await adapter.isAvailable()) {
        console.error(`${adapter.displayName} is not installed or not in PATH`);
        process.exit(1);
      }
      
      console.log(`[${adapter.displayName}]`);
      await session.send(prompt, tool);
      session.save(); // Persist session for forwarding
      console.log(''); // Add newline after output
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// Forward command - forward last response from one tool to another
program
  .command('forward <from> <to>')
  .description('Forward the last response from one tool to another for review')
  .option('-m, --message <msg>', 'Additional message to include')
  .action(async (from: string, to: string, options: { message?: string }) => {
    try {
      const fromAdapter = registry.get(from);
      const toAdapter = registry.get(to);
      
      if (!fromAdapter) {
        console.error(`Unknown source tool: ${from}`);
        process.exit(1);
      }
      if (!toAdapter) {
        console.error(`Unknown target tool: ${to}`);
        process.exit(1);
      }
      
      const lastResponse = session.getLastResponse(from);
      if (!lastResponse) {
        console.error(`No response from ${fromAdapter.displayName} to forward. Use 'aic ask ${from} "..."' first.`);
        process.exit(1);
      }
      
      console.log(`Forwarding ${fromAdapter.displayName}'s response to ${toAdapter.displayName}...`);
      console.log(`[${toAdapter.displayName}]`);
      await session.forward(from, to, options.message);
      session.save(); // Persist session
      console.log(''); // Add newline after output
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// History command - show session history
program
  .command('history')
  .description('Show the conversation history')
  .action(() => {
    session.load(); // Refresh from disk
    console.log(session.formatHistory());
  });

// Clear command - clear session history
program
  .command('clear')
  .description('Clear the session history')
  .action(() => {
    session.clear();
    session.save();
    console.log('Session cleared.');
  });

// Tools command - list available tools
program
  .command('tools')
  .description('List available AI tools and their status')
  .action(async () => {
    console.log('Available tools:\n');
    for (const adapter of registry.getAll()) {
      const available = await adapter.isAvailable();
      const status = available ? '✓ available' : '✗ not found';
      console.log(`  ${adapter.name.padEnd(10)} ${adapter.displayName.padEnd(15)} ${status}`);
    }
  });

// Interactive session command - SDK-based
program
  .command('start')
  .description('Start an interactive session with Claude Code and Gemini CLI')
  .action(async () => {
    await startSDKSession();
  });

program.parse();

