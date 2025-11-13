/**
 * Telegram Bot Integration
 * Handles commands and notifications via Telegram
 */

import { BrowserWindow } from 'electron';
import * as https from 'https';
import {
  TelegramCommand,
  TelegramCommandContext,
  TelegramCommandHandler,
  AppConfig,
} from '../../types';

// ============================================================================
// Constants
// ============================================================================

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_SEC = 30;

// ============================================================================
// Telegram Bot Class
// ============================================================================

export class TelegramBot {
  private config: AppConfig;
  private commands: Map<string, TelegramCommandHandler> = new Map();
  private lastUpdateId = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private managerWindow: BrowserWindow | null = null;
  private leadsWindow: BrowserWindow | null = null;

  constructor(
    config: AppConfig,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.config = config;
  }

  /**
   * Initialize bot
   */
  async initialize(
    managerWindow: BrowserWindow,
    leadsWindow: BrowserWindow
  ): Promise<void> {
    this.managerWindow = managerWindow;
    this.leadsWindow = leadsWindow;

    // Register default commands
    this.registerDefaultCommands();

    // Start polling
    await this.startPolling();

    this.log('info', 'Telegram bot initialized');
  }

  /**
   * Register a command handler
   */
  registerCommand(cmd: string, handler: TelegramCommandHandler): void {
    this.commands.set(cmd.toLowerCase(), handler);
    this.log('debug', `Registered command: /${cmd}`);
  }

  /**
   * Register default commands
   */
  private registerDefaultCommands(): void {
    // Help command
    this.registerCommand('help', {
      desc: 'Show available commands',
      handler: async (ctx) => {
        const commandList = Array.from(this.commands.entries())
          .filter(([_, handler]) => !handler.hidden)
          .map(([cmd, handler]) => `/${cmd} - ${handler.desc}`)
          .join('\n');

        await ctx.send(`📋 Available Commands:\n\n${commandList}`);
      },
    });

    // Status command
    this.registerCommand('status', {
      desc: 'Get application status',
      handler: async (ctx) => {
        const uptime = Math.floor(process.uptime());
        const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

        const status = `
📊 NiyatiBrowser Status

⏱️ Uptime: ${this.formatUptime(uptime)}
💾 Memory: ${memory} MB
🌐 Platform: ${process.platform}
📦 Node: ${process.version}
        `.trim();

        await ctx.send(status);
      },
    });

    // Ping command
    this.registerCommand('ping', {
      desc: 'Check if bot is responsive',
      handler: async (ctx) => {
        await ctx.send('🏓 Pong!');
      },
    });

    // Screenshot command
    this.registerCommand('screenshot', {
      desc: 'Capture window screenshot',
      handler: async (ctx) => {
        await this.handleScreenshot(ctx);
      },
    });

    // Logs command
    this.registerCommand('logs', {
      desc: 'Get recent log files',
      handler: async (ctx) => {
        await ctx.send('📄 Logs feature coming soon!');
      },
    });
  }

  /**
   * Handle screenshot command
   */
  private async handleScreenshot(ctx: TelegramCommandContext): Promise<void> {
    try {
      const windows = [
        { name: 'Manager', window: this.managerWindow },
        { name: 'Leads', window: this.leadsWindow },
      ];

      const screenshots: Array<{ name: string; buf: Buffer; caption?: string }> = [];

      for (const { name, window } of windows) {
        if (window && !window.isDestroyed()) {
          const image = await window.capturePage();
          const buf = image.toPNG();
          screenshots.push({
            name: `${name}.png`,
            buf,
            caption: `${name} Window`,
          });
        }
      }

      if (screenshots.length === 0) {
        await ctx.send('❌ No windows available for screenshot');
        return;
      }

      if (screenshots.length === 1) {
        await ctx.sendPhoto(screenshots[0].buf, { caption: screenshots[0].caption });
      } else {
        await ctx.sendMediaGroup(screenshots);
      }
    } catch (error) {
      this.log('error', `Screenshot error: ${error}`);
      await ctx.send(`❌ Screenshot failed: ${error}`);
    }
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Start polling for updates
   */
  async startPolling(): Promise<void> {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollUpdates();
    }, POLL_INTERVAL_MS);

    // Initial poll
    this.pollUpdates();

    this.log('info', 'Started polling Telegram updates');
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.isPolling = false;
    this.log('info', 'Stopped polling Telegram updates');
  }

  /**
   * Poll for updates
   */
  private async pollUpdates(): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return;
    }

    try {
      const updates = await this.apiRequest('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message'],
      });

      if (!updates.ok || !Array.isArray(updates.result)) {
        return;
      }

      for (const update of updates.result) {
        await this.handleUpdate(update);
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }
    } catch (error) {
      this.log('error', `Poll error: ${error}`);
    }
  }

  /**
   * Handle single update
   */
  private async handleUpdate(update: any): Promise<void> {
    const message = update.message;
    if (!message || !message.text) return;

    // Check if message is from authorized chat
    const chatId = String(message.chat.id);
    if (chatId !== this.config.telegramChatId) {
      this.log('warning', `Unauthorized message from chat: ${chatId}`);
      return;
    }

    const text = message.text.trim();

    // Only process commands
    if (!text.startsWith('/')) return;

    const parsed = this.parseCommand(text);
    await this.executeCommand(parsed, chatId);
  }

  /**
   * Parse command from text
   */
  private parseCommand(text: string): TelegramCommand {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    return {
      cmd,
      args,
      raw: text,
    };
  }

  /**
   * Execute command
   */
  private async executeCommand(command: TelegramCommand, chatId: string): Promise<void> {
    const handler = this.commands.get(command.cmd);

    if (!handler) {
      await this.sendMessage(chatId, `❌ Unknown command: /${command.cmd}\n\nUse /help to see available commands.`);
      return;
    }

    try {
      // Create context
      const ctx: TelegramCommandContext = {
        cmd: command.cmd,
        args: command.args,
        raw: command.raw,
        send: async (text: string, extra?: Record<string, unknown>) => {
          await this.sendMessage(chatId, text, extra);
        },
        sendPhoto: async (buffer: Buffer, options?: Record<string, unknown>) => {
          await this.sendPhoto(chatId, buffer, options);
        },
        sendMediaGroup: async (photos: Array<{ name: string; buf: Buffer; caption?: string }>) => {
          await this.sendMediaGroup(chatId, photos);
        },
      };

      // Execute handler
      await handler.handler(ctx);

      this.log('info', `Executed command: /${command.cmd}`);
    } catch (error) {
      this.log('error', `Command execution error: ${error}`);
      await this.sendMessage(chatId, `❌ Error executing command: ${error}`);
    }
  }

  /**
   * Send text message
   */
  async sendMessage(chatId: string, text: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.config.telegramBotToken) return;

    // Truncate message if too long
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n[Message truncated]'
      : text;

    const params = {
      chat_id: chatId,
      text: truncated,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    };

    await this.apiRequest('sendMessage', params);
  }

  /**
   * Send photo
   */
  async sendPhoto(chatId: string, buffer: Buffer, options?: Record<string, unknown>): Promise<void> {
    if (!this.config.telegramBotToken) return;

    const caption = options?.caption ? String(options.caption).slice(0, MAX_CAPTION_LENGTH) : undefined;

    const formData = {
      chat_id: chatId,
      photo: buffer,
      caption,
    };

    await this.apiRequestMultipart('sendPhoto', formData);
  }

  /**
   * Send media group (multiple photos)
   */
  async sendMediaGroup(
    chatId: string,
    photos: Array<{ name: string; buf: Buffer; caption?: string }>
  ): Promise<void> {
    if (!this.config.telegramBotToken) return;

    // For simplicity, send photos one by one
    // A proper implementation would use multipart/form-data with media group
    for (const photo of photos) {
      await this.sendPhoto(chatId, photo.buf, { caption: photo.caption });
    }
  }

  /**
   * Send notification
   */
  async sendNotification(message: string): Promise<void> {
    if (!this.config.telegramChatId) return;
    await this.sendMessage(this.config.telegramChatId, message);
  }

  /**
   * Make API request
   */
  private async apiRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    const token = this.config.telegramBotToken;
    if (!token) throw new Error('Telegram bot token not configured');

    const url = `${TELEGRAM_API}/bot${token}/${method}`;
    const body = JSON.stringify(params || {});

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error}`));
            }
          });
        }
      );

      req.on('error', (error) => {
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Make multipart API request (for file uploads)
   */
  private async apiRequestMultipart(method: string, formData: Record<string, any>): Promise<any> {
    const token = this.config.telegramBotToken;
    if (!token) throw new Error('Telegram bot token not configured');

    const url = `${TELEGRAM_API}/bot${token}/${method}`;

    // Build multipart form data
    const boundary = `----TelegramBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(formData)) {
      if (value === undefined) continue;

      parts.push(Buffer.from(`--${boundary}\r\n`));

      if (Buffer.isBuffer(value)) {
        // File data
        parts.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${key}"; filename="image.png"\r\n` +
            `Content-Type: image/png\r\n\r\n`
          )
        );
        parts.push(value);
        parts.push(Buffer.from('\r\n'));
      } else {
        // Text data
        parts.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            `${String(value)}\r\n`
          )
        );
      }
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error}`));
            }
          });
        }
      );

      req.on('error', (error) => {
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopPolling();
    this.commands.clear();
    this.log('info', 'Telegram bot cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
