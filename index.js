console.log('メインの処理を実行を開始します。');

//----------------------------------------------------------
// 各種読み込み
import { Client, GatewayIntentBits, ActivityType, REST, Routes, AttachmentBuilder } from 'discord.js';
import schedule from 'node-schedule';
import fs from 'fs';
import yaml from 'js-yaml';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

global.ReadableStream = fetch.ReadableStream;

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const discordPackage  = require('./package.json');

//----------------------------------------------------------
// グローバル変数
let lastName = '';  // 最後に発言したユーザ名

//----------------------------------------------------------
// configファイルの読み込み
console.log('設定ファイルを読み込みます。');
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

//----------------------------------------------------------
// 現在のディレクトリを取得（ESモジュール対応）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

//----------------------------------------------------------
// REST クライアントを作成
console.log('RESTクライアントを作成します。');
const rest = new REST({ version: '10' }).setToken(config.token);

//----------------------------------------------------------
// Discordクライアントの作成
console.log('Discordクライアントを作成します。');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});
client.login(config.token); // Discordのクライアントにログイン実行

// ギルドコマンドの登録処理
const guildCommands = [
    {
        name: 'image-url-converter',
        description: '指定した画像URLをオリジナル画像に置き換えます',
        options: [{
            name: 'url',
            type: 3, // 文字列
            description: '変換したいURLを入力してください',
            required: true
        }],
    },
    {
        name: 'help',
        description: 'このボットについて答えます'
    }
];

//----------------------------------------------------------
// コマンドハンドラ
const commandHandlers = {
    // サーバにコマンドを登録
    'register-guild-commands': async (_interaction) => {
        await rest.put(Routes.applicationGuildCommands(config.clientId, _interaction.guildId), { body: guildCommands });
        await _interaction.reply(`このサーバ (ID: ${_interaction.guildId}) にコマンドが登録されました。`);
    },
    // サーバのコマンドを削除
    'delete-guild-commands': async (_interaction) => {
        const _existingCommands = await rest.get(Routes.applicationGuildCommands(config.clientId, _interaction.guildId));
        for (const _command of _existingCommands) {
            await rest.delete(Routes.applicationGuildCommand(config.clientId, _interaction.guildId, _command.id));
        }
        await _interaction.reply(`このサーバ (ID: ${_interaction.guildId}) のコマンドが削除されました。`);
    },
    // オリジナル画質に画像を変換
    'image-url-converter': async (_interaction) => {
        const _url = _interaction.options.getString('url');
        const _converted = convertOriginalSizeImageURL(_url);
        const _message = _converted ? `オリジナル画質に変換しました！\n ${_converted}` : '指定したURLは変換に対応していないようです🥺';
        await _interaction.reply(_message);
    },
    // ヘルプを表示
    'help': async (_interaction) => {
        try {
            const _helpText = await readHelpFile();
            await _interaction.reply(_helpText);
        } catch {
            await _interaction.reply('ヘルプ情報の読み込みに失敗しました、質問はとーち。までご連絡ください🥺');
        }
    }
}

//----------------------------------------------------------
// URLを抽出して処理する関数
function convertOriginalSizeImageURL(_content) {
    // 入力URLが無効な場合はnullを返す
    if (!_content || typeof _content !== 'string') {
        return null;
    }

    // メッセージからURLを抽出
    const _urls = _content.match(/https?:\/\/[^\s]+/g);
    // urlが含まれない場合はnullを返す
    if (!_urls) return null;

    for (const _url of _urls) {
        // Youtubeの画像URLの場合
        if (_url.includes('yt3.ggpht.com')) {
            // 末尾の「=」以降を「=s0」に置換してURLを返す
            return _url.replace(/=.*/, '=s0');
        }

        // Xの画像URLの場合
        if (_url.includes('pbs.twimg.com')) {
            // 末尾の「?」以降を「?format=jpg&name=orig」に置換してURLを返す
            return _url.replace(/\?.*/, '?format=jpg&name=orig');
        }
    }

    // 変換対象じゃなかったときはnull
    return null;
}

//----------------------------------------------------------
// helpへの返信を取得する関数
function readHelpFile() {
    return new Promise((resolve, reject) => {
        fs.readFile('./help.txt', 'utf8', (err, data) => {
            if (err) {
                reject(err); // エラー時
            }
            else {
                resolve(data); // 成功時
            }
        });
    });
}

//----------------------------------------------------------
// メッセージ削除のスケジュールを設定する関数
function scheduleMessageDeletion(_message) {
    // メッセージにlockEmojiが含まれている場合は削除スケジュールを設定しない
    if (_message.content.includes(config.lockEmoji)) {
        console.log(config.lockEmoji + 'が含まれているため、削除しない');
        return;
    }

    console.log('削除スケジュール開始');
    schedule.scheduleJob(new Date(Date.now() + config.deleteTime * 1000), () => {
        _message.delete().catch(console.error);
    });
}

//----------------------------------------------------------
// ボットが準備完了した時のイベントハンドラ
client.once('ready', () => {
    client.user.setActivity('⚡️', { type: ActivityType.Custom, state: `⚡️Ver.${discordPackage.version}` });
    console.log(`${client.user.tag} がログインしました！`);
});

//----------------------------------------------------------
// エラーハンドリングの追加
client.on('error', (_error) => {
    console.error('クライアントエラー：', _error);
});

//----------------------------------------------------------
// 新しいメッセージが作成されたときのイベントハンドラ
client.on('messageCreate', async (_message) => {
    // ボット自身のメッセージや @everyone メンションを無視
    if (_message.author.bot || _message.mentions.everyone) return;

    // 自分自身のメッセージを無視
    if (_message.author.id === client.user.id) return;

    // ユーザーの表示名を取得
    let _displayName;
    try {
        const _member = await _message.guild.members.fetch(_message.author.id);
        _displayName = _member.displayName;
    } catch (error) {
        console.error('メンバーの取得に失敗しました:', error);
        _displayName = _message.author.username;
    }

    // メッセージからボットへのメンションを削除
    const _cleanedMessage = _message.content.replace(/<@!?(\d+)>/g, '').trim();

    // ボットへのメンションが含まれている場合
    if (_message.mentions.has(client.user)) {
        // メッセージにURLが含まれているかを確認する正規表現
        const _urlRegex = /(https?:\/\/[^\s]+)/g;

        // メッセージにURLが含まれている場合
        if (_urlRegex.test(_message.content)) {
            // メッセージ内のURLを変換
            const _convertedUrl = convertOriginalSizeImageURL(_message.content);
            if (_convertedUrl) {
                await _message.channel.send(`オリジナル画質に変換しました！\n${_convertedUrl}`);
            }
            else {
                const _sentMessage = await _message.channel.send(_cleanedMessage);
                if (config.allowedChannelIds.includes(_message.channel.id)) {
                    scheduleMessageDeletion(_sentMessage);
                }
            }
        }
        else {
            const _sentMessage = await _message.channel.send(_cleanedMessage);
            if (config.allowedChannelIds.includes(_message.channel.id)) {
                scheduleMessageDeletion(_sentMessage);
            }
        }
        await _message.delete().catch(console.error);
        return;
    }

    // 許可されたチャンネルでのみ動作
    if (config.allowedChannelIds.includes(_message.channel.id)) {
        const _logChannel = await client.channels.fetch(String(config.logChannelId));
        if (_logChannel) {
            let _logContent = '';
            if (_displayName !== lastName) {
                _logContent = `${_displayName}：\n`;
                lastName = _displayName;
            }
            _logContent += `>>> ${_cleanedMessage}\n`;

            // 添付ファイルがある場合は一時保存してログチャンネルに送信
            if (_message.attachments.size > 0) {
                for (const _attachment of _message.attachments.values()) {
                    const _response = await fetch(_attachment.url);
                    const _buffer = await _response.buffer();
                    const _fileName = `./temp/${_attachment.name}`;
                    fs.writeFileSync(_fileName, _buffer);
                    await _logChannel.send({
                        content: _logContent,
                        files: [ _fileName ]
                    });
                    fs.unlinkSync(_fileName); // 一時ファイルを削除
                }
            } else {
                await _logChannel.send(_logContent);
            }
        }

        // メッセージ削除のスケジュールを設定
        scheduleMessageDeletion(_message);
    }
});

//----------------------------------------------------------
// スラッシュコマンドのイベントハンドラ
client.on('interactionCreate', async (_interaction) => {
    if (!_interaction.isCommand()) return;
    const _handler = commandHandlers[_interaction.commandName];
    if (_handler) {
        console.log(`${_interaction.commandName} が開始。`);
        await _handler(_interaction);
        console.log(`${_interaction.commandName} が終了。`);
    }
});