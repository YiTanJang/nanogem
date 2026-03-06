import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    media?: { mimeType: string; data: string };
  }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private onFirstOpenCallback?: () => void;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(phoneNumber?: string, pairingCode?: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.onFirstOpenCallback = resolve;
      this.connectInternal(resolve, phoneNumber, pairingCode).catch(reject);
    });
  }

  private async connectInternal(
    onFirstOpen?: () => void,
    phoneNumber?: string,
    pairingCode?: boolean,
  ): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    // Handle pairing code request
    const usePairingEnv = process.env.USE_PAIRING_CODE === 'true';
    const phoneEnv = process.env.PHONE_NUMBER;
    const finalPhone = phoneNumber || phoneEnv;
    const shouldPair = pairingCode || usePairingEnv;

    if (shouldPair && finalPhone && !state.creds.me) {
      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(finalPhone);
          console.log(`\n🔗 Your WhatsApp pairing code: ${code}\n`);
        } catch (err) {
          logger.error({ err }, 'Failed to request pairing code');
        }
      }, 5000);
    }

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          'WhatsApp authentication required. Please scan the QR code or use a pairing code.',
        );
        // During normal run, we exit so the user knows they need to run auth
        // In tests, this allows mockExit to be called.
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect }, 'Connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          setTimeout(
            () => this.connectInternal(this.onFirstOpenCallback),
            5000,
          );
        } else {
          logger.info('Logged out. Please re-authenticate.');
          if (process.env.NODE_ENV === 'test') {
            process.exit(0);
          } else {
            setTimeout(() => process.exit(0), 1000);
          }
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        let chatJid = await this.translateJid(rawJid);
        // Strip device suffix (e.g. :1) for registration check
        if (chatJid.includes(':')) {
          chatJid = chatJid.split(':')[0] + '@' + chatJid.split('@')[1];
        }

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          isGroup,
        );

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          let media: { mimeType: string; data: string } | undefined;

          // Handle Image/Audio/Video media
          const isImage = !!msg.message?.imageMessage;
          const isAudio = !!msg.message?.audioMessage;
          const isVideo = !!msg.message?.videoMessage;

          if (isImage || isAudio || isVideo) {
            try {
              // Only attempt download if we have a real socket connection
              // In tests, downloadMediaMessage might fail if msg isn't fully structured
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const mimeType = isImage
                ? 'image/jpeg'
                : isAudio
                  ? 'audio/ogg; codecs=opus'
                  : 'video/mp4';

              media = {
                mimeType,
                data: (buffer as Buffer).toString('base64'),
              };

              if (isAudio && !content) {
                content = '[Voice Message]';
              }
            } catch (err) {
              // Silently skip media download failure in tests if it's just a mock issue
              if (process.env.NODE_ENV !== 'test') {
                logger.error(
                  { err, chatJid },
                  'Failed to download media message',
                );
                content += '\n[Media download failed]';
              }
            }
          }

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content && !media) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: 
          // 1. Never trigger on our own messages to avoid loops
          // 2. Otherwise use the trigger pattern
          const isBotMessage = !fromMe && TRIGGER_PATTERN.test(content);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            media, // Pass media to the router
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    media?: { mimeType: string; data: string },
  ): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed =
      ASSISTANT_HAS_OWN_NUMBER || (!text && media)
        ? text
        : `${ASSISTANT_NAME}: ${text}`;

    return this.sendInternal(jid, prefixed, media);
  }

  private async sendInternal(
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
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      if (media) {
        const buffer = Buffer.from(media.data, 'base64');
        if (media.mimeType.startsWith('audio/')) {
          await this.sock.sendMessage(jid, {
            audio: buffer,
            mimetype: media.mimeType,
            ptt: true, // Send as a voice note
          });
        } else if (media.mimeType.startsWith('image/')) {
          await this.sock.sendMessage(jid, {
            image: buffer,
            caption: text || undefined,
          });
        } else if (media.mimeType.startsWith('video/')) {
          await this.sock.sendMessage(jid, {
            video: buffer,
            caption: text || undefined,
          });
        } else {
          // Send as document if unknown type
          await this.sock.sendMessage(jid, {
            document: buffer,
            fileName: 'file',
            mimetype: media.mimeType,
            caption: text || undefined,
          });
        }
      } else {
        await this.sock.sendMessage(jid, { text });
      }
      logger.info(
        { jid, length: text?.length || 0, hasMedia: !!media },
        'Message sent',
      );
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text, media });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sendInternal(item.jid, item.text, item.media);
      }
    } finally {
      this.flushing = false;
    }
  }
}
