import { Client, GatewayIntentBits, ActivityType, REST, Routes } from 'discord.js';
import fs from 'fs';
import yaml from 'js-yaml';
import fetch from 'node-fetch';
import path from 'path';
import { createRequire } from 'module';
import { ReadableStream } from 'web-streams-polyfill';
import http from 'http';
import 'dotenv/config';

global.ReadableStream = ReadableStream;

const require = createRequire(import.meta.url);
const discordPackage = require('./package.json');

//------------------------------
// 設定読み込み
//------------------------------
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8')) || {};

// 許可チャンネルは Set にして O(1) 参照（配列の includes を毎メッセージ呼ばない）
const ALLOWED_CHANNEL_IDS = new Set((config.allowedChannelIds || []).map(String));
const LOCK_EMOJI = config.lockEmoji || '🔒️';
const DELETE_DELAY_MS = Math.max(0, Number(config.deleteTime ?? 0) * 1000);

// 添付ファイル転送の上限（メモリ保護）
const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024; // 1ファイル 8MB
const MAX_TOTAL_ATTACHMENTS = 16 * 1024 * 1024; // 1メッセージ合計 16MB
const MAX_BUFFER_BUDGET = 64 * 1024 * 1024; // 同時にメモリに載る総量の目安 64MB
const FETCH_TIMEOUT_MS = 15000;

// 保留中の削除タイマーの上限（暴走時の無限増加を防ぐ）
const MAX_PENDING_DELETIONS = 5000;

// サーバーごとの最後の発言者（ギルド数ぶんしか増えないが、上限も設ける）
const lastNames = new Map();
const MAX_LAST_NAMES = 1000;

// 削除予定のタイマー（メッセージID -> Timeout）
const deletionTimers = new Map();

// 添付ファイル転送で同時に確保しているバッファ量
let bufferBudgetUsed = 0;

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN || config.token;
const CLIENT_ID = process.env.CLIENT_ID || config.clientId;

if (!TOKEN) {
  console.error('Discord のトークンが設定されていません。');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

//------------------------------
// 想定外の例外でプロセスが落ちないようにする
//------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('未処理の Promise 拒否:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('捕捉されない例外:', error);
});

client.login(TOKEN);

//------------------------------
// HTTPサーバー (Render等のヘルスチェック / スリープ防止用)
//------------------------------
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord Bot is alive!');
});

server.listen(PORT, () => {
  console.log(`Health check server is running on port ${PORT}`);
});

//------------------------------
// サーバーコマンドの定義
//------------------------------
const guildCommands = [
  {
    name: 'image-url-converter',
    description: '指定した画像URLをオリジナル画像に置き換えます',
    options: [
      {
        name: 'url',
        type: 3,
        description: '変換したいURLを入力してください',
        required: true,
      },
    ],
  },
  {
    name: 'help',
    description: 'このボットについて答えます',
  },
];

//------------------------------
// ユーティリティ
//------------------------------
async function getLogChannel() {
  const id = config.logChannelId ? String(config.logChannelId) : '';
  if (!id) return null;

  const cached = client.channels.cache.get(id);
  if (cached) return cached;

  try {
    return await client.channels.fetch(id);
  } catch (error) {
    console.error(`ログチャンネル (${id}) の取得に失敗しました:`, error);
    return null;
  }
}

function getDisplayName(message) {
  const member = message.member ?? message.guild?.members.cache.get(message.author.id);
  return member?.displayName ?? message.author.username;
}

function rememberLastName(guildId, name) {
  if (lastNames.has(guildId)) {
    lastNames.set(guildId, name);
    return;
  }

  // 上限に達したら古い（先頭の）要素を捨ててから追加
  if (lastNames.size >= MAX_LAST_NAMES) {
    const oldestKey = lastNames.keys().next().value;
    lastNames.delete(oldestKey);
  }
  lastNames.set(guildId, name);
}

// メッセージ削除を安全にスケジュール (setTimeoutを使いメモリリークを防止)
function scheduleMessageDeletion(message) {
  if (!message?.id) return;

  if (message.content && message.content.includes(LOCK_EMOJI)) {
    console.log(`${LOCK_EMOJI}が含まれているため、削除しない`);
    return;
  }

  // 二重登録を防ぐ（同じメッセージに対して setTimeout を積まない）
  if (deletionTimers.has(message.id)) return;

  const timer = setTimeout(async () => {
    try {
      if (message.deletable) {
        await message.delete();
      }
    } catch (error) {
      // 既に削除済み(Unknown Message)などは無視してよい
      if (error?.code !== 10008) {
        console.error('メッセージの削除に失敗しました:', error);
      }
    } finally {
      deletionTimers.delete(message.id);
    }
  }, DELETE_DELAY_MS);

  // Map が無制限に膨らまないように、上限超過時は追跡せず発火させる
  if (deletionTimers.size >= MAX_PENDING_DELETIONS) {
    console.warn('削除待ちタイマーが上限に達したため、追跡せずに削除を実行します。');
    return;
  }

  deletionTimers.set(message.id, timer);
}

function cancelMessageDeletion(messageId) {
  const timer = deletionTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    deletionTimers.delete(messageId);
  }
}

async function replySafely(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(content);
    } else {
      await interaction.reply(content);
    }
  } catch (error) {
    console.error('インタラクションへの応答に失敗しました:', error);
  }
}

//------------------------------
// イベント
//------------------------------
client.once('ready', () => {
  client.user.setActivity('⚡️', { type: ActivityType.Custom, state: `⚡️Ver.${discordPackage.version}` });
  console.log(`${client.user.tag} がログインしました！`);
});

client.on('error', (_error) => {
  console.error('クライアントエラー：', _error);
});

// メッセージが先に消えた場合はタイマーを解放する
client.on('messageDelete', (message) => {
  if (message?.id) cancelMessageDeletion(message.id);
});

client.on('channelDelete', (channel) => {
  if (!channel?.id) return;
  if (channel.id === String(config.logChannelId || '')) {
    console.warn('ログチャンネルが削除されました。');
  }
});

client.on('messageCreate', async (_message) => {
  try {
    if (!_message.guild || _message.author.bot || _message.system) return;
    if (_message.mentions.everyone) return;
    if (_message.author.id === client.user.id) return;

    const displayName = getDisplayName(_message);
    const cleanedMessage = _message.content.replace(/<@!?(\d+)>/g, '').trim();
    const inAllowedChannel = ALLOWED_CHANNEL_IDS.has(_message.channel.id);

    if (_message.mentions.has(client.user)) {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      if (urlRegex.test(_message.content)) {
        const convertedUrl = convertOriginalSizeImageURL(_message.content);
        if (convertedUrl) {
          await _message.channel.send(`オリジナル画質に変換しました！\n ${convertedUrl} `);
        } else if (cleanedMessage) {
          const sentMessage = await _message.channel.send(cleanedMessage);
          if (inAllowedChannel) scheduleMessageDeletion(sentMessage);
        }
      } else if (cleanedMessage) {
        const sentMessage = await _message.channel.send(cleanedMessage);
        if (inAllowedChannel) scheduleMessageDeletion(sentMessage);
      }
      await _message.delete().catch((error) => {
        if (error?.code !== 10008) console.error('メンション元メッセージの削除に失敗しました:', error);
      });
      return;
    }

    if (!inAllowedChannel) return;

    const logChannel = await getLogChannel();
    if (logChannel) {
      let logContent = '';
      const guildId = _message.guild.id;
      const lastName = lastNames.get(guildId) || '';

      if (displayName !== lastName) {
        logContent = `${displayName}：\n`;
        rememberLastName(guildId, displayName);
      }

      if (cleanedMessage) {
        logContent += `>>> ${cleanedMessage}\n`;
      } else if (!logContent && _message.attachments.size === 0) {
        // スタンプのみ等、送る中身が無い場合はスキップ
        logContent = '';
      }

      if (logContent) {
        await logChannel.send(logContent).catch((error) => {
          console.error('ログの送信に失敗しました:', error);
        });
      }

      // ファイルが含まれていた場合、ディスクに書き込まずBufferとして直接送信
      if (_message.attachments.size > 0) {
        let totalBytes = 0;

        for (const attachment of _message.attachments.values()) {
          if (attachment.size > MAX_ATTACHMENT_SIZE) {
            console.error('ファイルサイズが大きすぎたため、ログサーバに送信できませんでした');
            continue;
          }

          totalBytes += attachment.size;
          if (
            totalBytes > MAX_TOTAL_ATTACHMENTS ||
            bufferBudgetUsed + attachment.size > MAX_BUFFER_BUDGET
          ) {
            console.error('添付ファイルの合計サイズが上限を超えたため、残りは転送しませんでした');
            break;
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

          try {
            const response = await fetch(attachment.url, { signal: controller.signal });
            if (!response.ok) {
              throw new Error(`添付ファイルの取得に失敗 (HTTP ${response.status})`);
            }

            bufferBudgetUsed += attachment.size;
            const buffer = await response.buffer();
            const fileName = path.basename(attachment.name || 'file');

            await logChannel.send({
              files: [{ attachment: buffer, name: fileName }],
            });
          } catch (err) {
            console.error('添付ファイルの転送に失敗しました:', err);
          } finally {
            bufferBudgetUsed = Math.max(0, bufferBudgetUsed - attachment.size);
            clearTimeout(timeout);
          }
        }
      }
    }

    scheduleMessageDeletion(_message);
  } catch (error) {
    console.error('messageCreate の処理でエラーが発生しました:', error);
  }
});

client.on('interactionCreate', async (_interaction) => {
  if (!_interaction.isCommand()) return;

  try {
    const { commandName, guildId } = _interaction;

    if (commandName === 'register-guild-commands') {
      console.log(`register-guild-commands が開始。`);
      await registerGuildCommands(guildId);
      await replySafely(_interaction, `このサーバ (ID: ${guildId}) にコマンドが登録されました。`);
      console.log(`register-guild-commands が終了。`);
      return;
    }

    if (commandName === 'delete-guild-commands') {
      console.log(`delete-guild-commands が開始。`);
      await deleteGuildCommands(guildId);
      await replySafely(_interaction, `このサーバ (ID: ${guildId}) のコマンドが削除されました。`);
      console.log(`delete-guild-commands が終了。`);
      return;
    }

    if (commandName === 'image-url-converter') {
      console.log(`image-url-converter が開始。`);
      const inputUrl = _interaction.options.getString('url');
      if (!inputUrl) {
        await replySafely(_interaction, 'URLを正しく入力してください🥺');
        console.log(`image-url-converter が 受け取った変数のエラーで終了。`);
        return;
      }

      const convertedUrl = convertOriginalSizeImageURL(inputUrl);
      if (convertedUrl) {
        await replySafely(_interaction, `オリジナル画質に変換しました！\n ${convertedUrl} `);
      } else {
        await replySafely(_interaction, '指定したURLは変換に対応していないようです🥺');
      }
      console.log(`image-url-converter が終了。`);
      return;
    }

    if (commandName === 'help') {
      console.log(`help が開始。`);
      try {
        const helpText = await readHelpFile();
        await replySafely(_interaction, helpText);
      } catch (error) {
        console.error('ヘルプファイルの読み込みに失敗しました:', error);
        await replySafely(_interaction, 'ヘルプ情報の読み込みに失敗しました、質問はとーち。までご連絡ください🥺');
      }
      console.log(`help が終了。`);
      return;
    }

    // 未対応コマンドでも「応答なし」でタイムアウトしないようにする
    await replySafely(_interaction, 'このコマンドは現在利用できません🥺');
  } catch (error) {
    console.error('interactionCreate の処理でエラーが発生しました:', error);
    await replySafely(_interaction, 'コマンドの実行中にエラーが発生しました🥺');
  }
});

//------------------------------
// コマンド登録 / 削除
//------------------------------
async function registerGuildCommands(_guildId) {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, _guildId), {
      body: guildCommands,
    });
    console.log(`ギルドコマンドがギルド ${_guildId} に正常に登録されました。`);
  } catch (error) {
    console.error(`ギルドコマンドの登録に失敗しました (ギルド: ${_guildId}):`, error);
  }
}

async function deleteGuildCommands(_guildId) {
  try {
    const existingCommands = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, _guildId));
    if (Array.isArray(existingCommands) && existingCommands.length > 0) {
      console.log(`ギルド ${_guildId} の既存のコマンドを削除しています...`);
      for (const command of existingCommands) {
        await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, _guildId, command.id));
        console.log(`ギルドコマンド '${command.name}' (ID: ${command.id}) を削除しました。`);
      }
    } else {
      console.log(`ギルド ${_guildId} に削除するコマンドはありません。`);
    }
  } catch (error) {
    console.error(`ギルドコマンドの削除に失敗しました (ギルド: ${_guildId}):`, error);
  }
}

function convertOriginalSizeImageURL(_messageContent) {
  if (!_messageContent || typeof _messageContent !== 'string') {
    return null;
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = _messageContent.match(urlRegex);

  if (urls) {
    for (const url of urls) {
      if (url.includes('yt3.ggpht.com')) {
        return url.replace(/=.*/, '=s0');
      }

      if (url.includes('pbs.twimg.com')) {
        return url.replace(/\?.*/, '?format=jpg&name=orig');
      }
    }
  }

  return null;
}

function readHelpFile() {
  return fs.promises.readFile('./help.txt', 'utf8');
}

//------------------------------
// 終了処理（タイマーとHTTPサーバーを確実に解放）
//------------------------------
async function shutdown(signal) {
  console.log(`${signal} を受信したため終了処理を行います...`);

  for (const timer of deletionTimers.values()) {
    clearTimeout(timer);
  }
  deletionTimers.clear();
  lastNames.clear();

  server.close();
  await client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
