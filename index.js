console.log('メインの処理を実行を開始します。');

//----------------------------------------------------------
// 各種読み込み
import { Client, GatewayIntentBits, ActivityType, REST, Routes } from 'discord.js';
import schedule from 'node-schedule';
import fs from 'fs';
import yaml from 'js-yaml';
import fetch from 'node-fetch';

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
// メッセージ削除のスケジュールを設定する関数
function scheduleMessageDeletion(message) {
    const deleteTime = new Date(Date.now() + config.deleteTime * 1000);

    // メッセージにlockEmojiが含まれている場合は削除スケジュールを設定しない
    if (message.content.includes(config.lockEmoji)) {
        console.log(config.lockEmoji + 'が含まれているため、削除しない');
        return;
    }

    console.log('削除スケジュール開始');

    const job = schedule.scheduleJob(deleteTime, () => {
        message.delete().catch(console.error);
    });
    message.scheduledJob = job;
}

//----------------------------------------------------------
// ボットが準備完了した時のイベントハンドラ
client.once('ready', () => {
    client.user.setActivity('⚡️', { type: ActivityType.Custom, state: `⚡️Ver.${discordPackage.version}` });
    console.log(`${client.user.tag} がログインしました！`);
});

//----------------------------------------------------------
// エラーハンドリングの追加
client.on('error', (error) => {
    console.error('クライアントエラー：', error);
});

//----------------------------------------------------------
// 新しいメッセージが作成されたときのイベントハンドラ
client.on('messageCreate', async (message) => {
    // ボットには反応しない
    //if (message.author.bot) return;   // ボットに返事させた場合にメッセージが残っちゃうのでこの処理は一旦放置
    // @here / @everyoneメンションを無視
    if (message.mentions.everyone) return;
    // 自分自身のメッセージを無視
    if (message.author.id === client.user.id) return;

    // サーバ内でのユーザーのニックネームを取得
    const member = await message.guild.members.fetch(message.author.id);
    const displayName = member ? member.displayName : message.author.username;

    // メッセージからボットへのメンションを削除
    const cleanedMessage = message.content.replace(/<@!?(\d+)>/g, '').trim();

    // 自分宛てのメッセージが来たとき
    if (message.mentions.has(client.user)) {
        // メッセージにURLが含まれているかを確認する正規表現
        const urlRegex = /(https?:\/\/[^\s]+)/g;

        // メッセージにURLが含まれている場合
        if (urlRegex.test(message.content)) {
            // メッセージ内のURLを変換
            const convertedUrl = ConvertOriginalSizeImageURL(message);
            if (convertedUrl) {
                // メンションを飛ばしたメッセージと同じ内容を投稿
                await message.channel.send(`オリジナル画質に変換しました！\n ${convertedUrl} `);
            }
            else {
                // メンションを飛ばしたメッセージと同じ内容を投稿
                const sentMessage = await message.channel.send(cleanedMessage);
                // 削除スケジュール設定
                if (config.allowedChannelIds.includes(message.channel.id)) {
                    scheduleMessageDeletion(sentMessage);
                }
            }
        }
        else {
            // メンションを飛ばしたメッセージと同じ内容を投稿
            const sentMessage = await message.channel.send(cleanedMessage);
            // 削除スケジュール設定
            if (config.allowedChannelIds.includes(message.channel.id)) {
                scheduleMessageDeletion(sentMessage);
            }
        }
        // 元のメッセージを削除
        await message.delete().catch(console.error);

        return;
    }

    // 動作を許可されているチャンネル以外で動かない機能
    if (config.allowedChannelIds.includes(message.channel.id)) {
        // ログサーバに転送
        const logChannel = await client.channels.fetch(String(config.logChannelId));

        if (logChannel) {
            let logContent = ``;
            if (displayName !== lastName) {
                logContent = `${displayName}：\n`;
                lastName = displayName;
            }
            logContent += `>>> ${cleanedMessage}\n`;

            // 添付ファイルがある場合はそれも含めて送信
            if (message.attachments.size > 0) {
                const attachmentUrls = message.attachments.map(att => att.url).join('\n');
                logContent += `${attachmentUrls}`;
            }
            await logChannel.send(logContent);
        }

        // メッセージ削除のスケジュールを設定
        scheduleMessageDeletion(message);
    }
});

//----------------------------------------------------------
// スラッシュコマンドのイベントハンドラ
client.on('interactionCreate', async (interaction) => {
    // スラッシュコマンドでなければ無視
    if (!interaction.isCommand()) return;

    const { commandName, guildId } = interaction;

    if (commandName === 'register-guild-commands') {
        console.log(`register-guild-commands が開始。`);
        await registerGuildCommands(guildId);
        await interaction.reply(`このサーバ (ID: ${guildId}) にコマンドが登録されました。`);

        console.log(`register-guild-commands が終了。`);
        return;
    }
  
    if (commandName === 'delete-guild-commands') {
        console.log(`delete-guild-commands が開始。`);
        await deleteGuildCommands(guildId);
        await interaction.reply(`このサーバ (ID: ${guildId}) のコマンドが削除されました。`);
        
        console.log(`delete-guild-commands が終了。`);
        return;
    }

    if (commandName === 'image-url-converter') {
        console.log(`image-url-converter が開始。`);

        // 入力されたURLを取得
        const inputUrl = interaction.options.getString('url');
        if(!inputUrl) {
            await interaction.reply('URLを正しく入力してください🥺');
            console.log(`image-url-converter が 受け取った変数のエラーで終了。`);
            return;
        }

        // URLを変換
        const convertedUrl = ConvertOriginalSizeImageURL(inputUrl);

        // 変換されたURLを返信
        if (convertedUrl) {
            await interaction.reply(`オリジナル画質に変換しました！\n ${convertedUrl} `);
        }
        else {
            await interaction.reply('指定したURLは変換に対応していないようです🥺');
        }
        console.log(`image-url-converter が終了。`);
        return;
    }

    if (commandName === 'help') {
        console.log(`help が開始。`);
        try {
            // テキストファイルの内容を読み込む
            const helpText = await readHelpFile();

            // ファイルの内容をそのまま返信
            await interaction.reply(helpText);
        }
        catch (error) {
            console.error('ヘルプファイルの読み込みに失敗しました:', error);
            await interaction.reply('ヘルプ情報の読み込みに失敗しました、質問はとーち。までご連絡ください🥺');
        }
        console.log(`help が終了。`);
    }
});

//----------------------------------------------------------
// ギルドコマンドを登録
async function registerGuildCommands(guildId) {
    try {
        await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
            body: guildCommands,
        });
        console.log(`ギルドコマンドがギルド ${guildId} に正常に登録されました。`);
    }
    catch (error) {
        console.error(`ギルドコマンドの登録に失敗しました (ギルド: ${guildId}):`, error);
    }
}

//----------------------------------------------------------
// ギルドコマンドを削除
async function deleteGuildCommands(guildId) {
    try {
        const existingCommands = await rest.get(Routes.applicationGuildCommands(config.clientId, guildId));

        if (existingCommands.length > 0) {
            console.log(`ギルド ${guildId} の既存のコマンドを削除しています...`);
            for (const command of existingCommands) {
                await rest.delete(Routes.applicationGuildCommand(config.clientId, guildId, command.id));
                console.log(`ギルドコマンド '${command.name}' (ID: ${command.id}) を削除しました。`);
            }
        }
        else {
            console.log(`ギルド ${guildId} に削除するコマンドはありません。`);
        }
    }
    catch (error) {
        console.error(`ギルドコマンドの削除に失敗しました (ギルド: ${guildId}):`, error);
    }
}

//----------------------------------------------------------
// URLを抽出して処理する関数
function ConvertOriginalSizeImageURL(message) {
    // 入力URLが無効な場合はnullを返す
    if (!message || typeof message !== 'string') {
        return null;
    }

    // メッセージにURLが含まれているかを確認する正規表現
    const urlRegex = /(https?:\/\/[^\s]+)/g;
  
    // メッセージからURLを抽出
    const urls = message.match(urlRegex);

    if (urls) {
        for (const url of urls) {
            // Youtubeの画像URLの場合
            if (url.includes('yt3.ggpht.com')) {
                // 末尾の「=」以降を「=s0」に置換してURLを返す
                return url.replace(/=.*/, '=s0');
            }

            // Xの画像URLの場合
            if (url.includes('pbs.twimg.com')) {
                // 末尾の「?」以降を「?format=jpg&name=orig」に置換してURLを返す
                return url.replace(/\?.*/, '?format=jpg&name=orig');
            }
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