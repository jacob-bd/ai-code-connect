import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface ToolConfig {
  command?: string;
  defaultFlags?: string[];
}

export interface Config {
  defaultTool: string;
  tools: {
    [name: string]: ToolConfig;
  };
}

const DEFAULT_CONFIG: Config = {
  defaultTool: 'claude',
  tools: {
    claude: {
      command: 'claude',
      defaultFlags: ['-p', '--output-format', 'text'],
    },
    gemini: {
      command: 'gemini',
      defaultFlags: ['-o', 'text'],
    },
  },
};

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return join(homedir(), '.aic');
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Ensure the config directory exists
 */
export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load configuration from disk, or return defaults
 */
export function loadConfig(): Config {
  const configPath = getConfigPath();
  
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const loaded = JSON.parse(content) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...loaded,
      tools: {
        ...DEFAULT_CONFIG.tools,
        ...loaded.tools,
      },
    };
  } catch {
    console.warn('Failed to load config, using defaults');
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config: Config): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

