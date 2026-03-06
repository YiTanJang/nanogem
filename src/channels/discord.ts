import { Client, GatewayIntentBits, Partials, TextChannel } from 'discord.js';
import {
  ASSISTANT_NAME,
  ASSISTANT_HAS_OWN_NUMBER, // This is WhatsApp specific, but keeping for now as a placeholder for potential future shared-bot logic
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, NewMessage, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  token: string;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    media?: { mimeType: string; data: string };
  }> = [];
  private flushing = false;

  private opts: DiscordChannelOpts;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.on('ready', () => {
        this.connected = true;
        logger.info(`Connected to Discord as ${this.client.user?.tag}`);
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing Discord queue'),
        );
        resolve();
      });

      this.client.on('messageCreate', async (message) => {
        // Ignore messages from self (by ID or by name backstop)
        if (message.author.id === this.client.user?.id || message.author.username.includes('NanoClaw')) {
          return;
        }

        logger.debug({ 
          author: message.author.username, 
          content: message.content, 
          channel: message.channelId 
        }, 'Raw Discord message received');

        const chatJid = `discord-${message.channel.id}`;
        const timestamp = message.createdAt.toISOString();
        const sender = `discord-${message.author.id}`;
        const senderName = message.author.username;
        const content = message.content;
        const isFromMe = false;

        // Trigger logic for Discord: 
        // 1. Direct mentions of the bot identity
        // 2. All Direct Messages
        const isMentioned = message.mentions.has(this.client.user!.id);
        const isDM = message.channel.type === 1; // DMChannel type is 1
        const isBotMessage = isMentioned || isDM;

        // Notify about chat metadata for group discovery
        const isGroup = message.channel.type === 0; // TextChannel type is 0
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          (message.channel as TextChannel).name || undefined,
          'discord',
          isGroup,
        );

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          let media: { mimeType: string; data: string } | undefined;
          if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            if (attachment && attachment.contentType) {
              try {
                const response = await fetch(attachment.url);
                const buffer = await response.arrayBuffer();
                media = {
                  mimeType: attachment.contentType,
                  data: Buffer.from(buffer).toString('base64'),
                };
              } catch (err) {
                logger.error({ err, chatJid }, 'Failed to download Discord media attachment');
              }
            }
          }

          this.opts.onMessage(chatJid, {
            id: message.id,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            media,
            timestamp,
            is_from_me: isFromMe,
            is_bot_message: isBotMessage,
          });
        }
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    media?: { mimeType: string; data: string },
  ): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, media });
      logger.info(
        {
          jid,
          length: text?.length || 0,
          queueSize: this.outgoingQueue.length,
        },
        'Discord disconnected, message queued',
      );
      return;
    }

    try {
      const channelId = jid.replace('discord-', '');
      const channel = await this.client.channels.fetch(channelId);
      const channelName = (channel as any)?.name || 'Unknown';
      logger.debug({ jid, channelId, channelName }, 'Fetching Discord channel for delivery');

      if (channel?.isTextBased()) {
        const messagesToSend: string[] = [];
        let currentMessage = text;

        if (media) {
          // Discord has attachment limits. For now, just send a basic message
          // with attachment details if media is present, or the raw text.
          if (text) {
            messagesToSend.push(`${text} (Media: ${media.mimeType})`);
          } else {
            messagesToSend.push(`(Media: ${media.mimeType})`);
          }
          // Note: Full media upload is more complex and would require Discord's FileAttachment
          // For now, we are just acknowledging the media.
        } else if (currentMessage) {
          // Discord message character limit is 2000. Split messages if longer.
          while (currentMessage.length > 0) {
            messagesToSend.push(currentMessage.substring(0, 2000));
            currentMessage = currentMessage.substring(2000);
          }
        }

        for (const msgPart of messagesToSend) {
          await (channel as any).send(msgPart);
        }

        logger.debug({ jid, parts: messagesToSend.length }, 'Discord message parts sent');

        logger.info(
          { jid, length: text?.length || 0, hasMedia: !!media },
          'Discord message sent',
        );
      } else {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        this.outgoingQueue.push({ jid, text, media });
      }
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Discord message');
      this.outgoingQueue.push({ jid, text, media });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('discord-');
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      logger.info('Disconnecting from Discord');
      this.client.destroy();
      this.connected = false;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const channelId = jid.replace('discord-', '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        if (isTyping) {
          await (channel as any).sendTyping();
        } else {
          // Discord.js doesn't have a direct way to "end" typing, it stops automatically after a few seconds.
          // So, no explicit action needed for `isTyping: false` other than not sending `sendTyping()`.
        }
        logger.debug({ jid, isTyping }, 'Discord typing status updated');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Discord typing status');
    }
  }

  // Discord doesn't have a direct equivalent of WhatsApp's group metadata sync.
  // For group/channel discovery, we rely on onChatMetadata from incoming messages.
  async syncGroupMetadata(force = false): Promise<void> {
    logger.debug('Discord syncGroupMetadata called, but no-op for Discord channel.');
    return Promise.resolve();
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing Discord message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already formatted by sendMessage
        await this.sendMessage(item.jid, item.text, item.media);
      }
    } finally {
      this.flushing = false;
    }
  }
}
