import { Client, GatewayIntentBits, ActivityType, REST, Routes } from 'discord.js';
import schedule from 'node-schedule';
import fs from 'fs';
import yaml from 'js-yaml';
import fetch from 'node-fetch';
import path from 'path';
import { createRequire } from 'module';
import { ReadableStream } from 'web-streams-polyfill';
global.ReadableStream = ReadableStream;

const require = createRequire(import.meta.url);
const discordPackage = require('./package.json');

let lastName = '';
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));
const rest = new REST({ version: '10' }).setToken(config.token);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.login(config.token);

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

function scheduleMessageDeletion(_message) {
  if (_message.content.includes(config.lockEmoji)) {
    console.log(`${config.lockEmoji}が含まれているため、削除しない`);
    return;
  }

  const deleteTime = new Date(Date.now() + config.deleteTime * 1000);
  const job = schedule.scheduleJob(deleteTime, () => {
    _message.delete().catch(console.error);
  });
  _message.scheduledJob = job;
}

client.once('ready', () => {
  client.user.setActivity('⚡️', { type: ActivityType.Custom, state: `⚡️Ver.${discordPackage.version}` });
  console.log(`${client.user.tag} がログインしました！`);
});

client.on('error', (_error) => {
  console.error('クライアントエラー：', _error);
});

client.on('messageCreate', async (_message) => {
  if (_message.mentions.everyone || _message.author.id === client.user.id) return;

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
      if (displayName !== lastName) {
        logContent = `${displayName}：\n`;
        lastName = displayName;
      }
      logContent += `>>> ${cleanedMessage}\n`;

      if (_message.attachments.size > 0) {
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        for (const attachment of _message.attachments.values()) {
          const fileName = path.basename(attachment.name);
          const filePath = path.join(tempDir, fileName);
          const response = await fetch(attachment.url);
          const buffer = await response.buffer();
          fs.writeFileSync(filePath, buffer);
          await logChannel.send({ files: [filePath] });
          fs.unlinkSync(filePath);
        }
      }

      await logChannel.send(logContent);
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
    await rest.put(Routes.applicationGuildCommands(config.clientId, _guildId), {
      body: guildCommands,
    });
    console.log(`ギルドコマンドがギルド ${_guildId} に正常に登録されました。`);
  } catch (error) {
    console.error(`ギルドコマンドの登録に失敗しました (ギルド: ${_guildId}):`, error);
  }
}

async function deleteGuildCommands(_guildId) {
  try {
    const existingCommands = await rest.get(Routes.applicationGuildCommands(config.clientId, _guildId));
    if (existingCommands.length > 0) {
      console.log(`ギルド ${_guildId} の既存のコマンドを削除しています...`);
      for (const command of existingCommands) {
        await rest.delete(Routes.applicationGuildCommand(config.clientId, _guildId, command.id));
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
