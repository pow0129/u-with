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

// サーバーごとの最後の発言者を管理するMap
const lastNames = new Map();
// 削除予定のタイマーを管理するMap
const deletionTimers = new Map();

const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

// 機密情報は環境変数（.env または PaaSの設定）から優先的に取得する
const TOKEN = process.env.DISCORD_TOKEN || config.token;
const CLIENT_ID = process.env.CLIENT_ID || config.clientId;

const rest = new REST({ version: '10' }).setToken(TOKEN);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
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

// メッセージ削除を安全にスケジュール (setTimeoutを使いメモリリークを防止)
function scheduleMessageDeletion(message) {
  if (message.content.includes(config.lockEmoji)) {
    console.log(`${config.lockEmoji}が含まれているため、削除しない`);
    return;
  }

  const delayMs = config.deleteTime * 1000;
  const timer = setTimeout(async () => {
    try {
      if (message.deletable) {
        await message.delete();
      }
    } catch (error) {
      console.error('メッセージの削除に失敗しました:', error);
    } finally {
      deletionTimers.delete(message.id);
    }
  }, delayMs);

  deletionTimers.set(message.id, timer);
}

client.once('ready', () => {
  client.user.setActivity('⚡️', { type: ActivityType.Custom, state: `⚡️Ver.${discordPackage.version}` });
  console.log(`${client.user.tag} がログインしました！`);
});

client.on('error', (_error) => {
  console.error('クライアントエラー：', _error);
});

client.on('messageCreate', async (_message) => {
  if (!_message.guild || _message.mentions.everyone || _message.author.id === client.user.id) return;

  let displayName = _message.author.username;
  try {
    const member = await _message.guild.members.fetch(_message.author.id);
    displayName = member.displayName;
  } catch (error) {
    console.warn(`ユーザー情報の取得に失敗しました: ${_message.author.id}`);
  }

  const cleanedMessage = _message.content.replace(/<@!?(\d+)>/g, '').trim();

  if (_message.mentions.has(client.user)) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    if (urlRegex.test(_message.content)) {
      const convertedUrl = convertOriginalSizeImageURL(_message.content);
      if (convertedUrl) {
        await _message.channel.send(`オリジナル画質に変換しました！\n ${convertedUrl} `);
      } else {
        const sentMessage = await _message.channel.send(cleanedMessage);
        if (config.allowedChannelIds.includes(_message.channel.id)) {
          scheduleMessageDeletion(sentMessage);
        }
      }
    } else {
      const sentMessage = await _message.channel.send(cleanedMessage);
      if (config.allowedChannelIds.includes(_message.channel.id)) {
        scheduleMessageDeletion(sentMessage);
      }
    }
    await _message.delete().catch(console.error);
    return;
  }

  if (config.allowedChannelIds.includes(_message.channel.id)) {
    const logChannel = await client.channels.fetch(String(config.logChannelId));
    if (logChannel) {
      let logContent = '';
      const guildId = _message.guild.id;
      const lastName = lastNames.get(guildId) || '';

      if (displayName !== lastName) {
        logContent = `${displayName}：\n`;
        lastNames.set(guildId, displayName);
      }
      logContent += `>>> ${cleanedMessage}\n`;

      // ログを送信
      await logChannel.send(logContent);

      // ファイルが含まれていた場合、ディスクに書き込まずBufferとして直接送信
      if (_message.attachments.size > 0) {
        for (const attachment of _message.attachments.values()) {
          const MAX_SIZE = 8 * 1024 * 1024; // 8MB
          if (attachment.size <= MAX_SIZE) {
            try {
              const response = await fetch(attachment.url);
              const buffer = await response.buffer();
              const fileName = path.basename(attachment.name);

              await logChannel.send({
                files: [{ attachment: buffer, name: fileName }]
              });
            } catch (err) {
              console.error('添付ファイルの転送に失敗しました:', err);
            }
          } else {
            console.error('ファイルサイズが大きすぎたため、ログサーバに送信できませんでした');
          }
        }
      }
    }

    scheduleMessageDeletion(_message);
  }
});

client.on('interactionCreate', async (_interaction) => {
  if (!_interaction.isCommand()) return;

  const { commandName, guildId } = _interaction;

  if (commandName === 'register-guild-commands') {
    console.log(`register-guild-commands が開始。`);
    await registerGuildCommands(guildId);
    await _interaction.reply(`このサーバ (ID: ${guildId}) にコマンドが登録されました。`);
    console.log(`register-guild-commands が終了。`);
    return;
  }

  if (commandName === 'delete-guild-commands') {
    console.log(`delete-guild-commands が開始。`);
    await deleteGuildCommands(guildId);
    await _interaction.reply(`このサーバ (ID: ${guildId}) のコマンドが削除されました。`);
    console.log(`delete-guild-commands が終了。`);
    return;
  }

  if (commandName === 'image-url-converter') {
    console.log(`image-url-converter が開始。`);
    const inputUrl = _interaction.options.getString('url');
    if (!inputUrl) {
      await _interaction.reply('URLを正しく入力してください🥺');
      console.log(`image-url-converter が 受け取った変数のエラーで終了。`);
      return;
    }

    const convertedUrl = convertOriginalSizeImageURL(inputUrl);
    if (convertedUrl) {
      await _interaction.reply(`オリジナル画質に変換しました！\n ${convertedUrl} `);
    } else {
      await _interaction.reply('指定したURLは変換に対応していないようです🥺');
    }
    console.log(`image-url-converter が終了。`);
    return;
  }

  if (commandName === 'help') {
    console.log(`help が開始。`);
    try {
      const helpText = await readHelpFile();
      await _interaction.reply(helpText);
    } catch (error) {
      console.error('ヘルプファイルの読み込みに失敗しました:', error);
      await _interaction.reply('ヘルプ情報の読み込みに失敗しました、質問はとーち。までご連絡ください🥺');
    }
    console.log(`help が終了。`);
  }
});

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
    if (existingCommands.length > 0) {
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
  return new Promise((resolve, reject) => {
    fs.readFile('./help.txt', 'utf8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}