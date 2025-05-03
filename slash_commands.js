import fs from 'fs';
import yaml from 'js-yaml';
import { REST, Routes, VoiceRegion } from 'discord.js';
const { clientId, token, guildId } = loadConfig();
const rest = new REST({ version: '10' }).setToken(token);

//----------------------------------------------------------
// config.ymlを読み込む関数
function loadConfig() {
    try {
        const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));
        return config;
    }
    catch (error) {
        console.error('YAMLファイルの読み込みに失敗しました:', error);
        process.exit(1); // エラー発生時にプロセスを終了
    }
}

//----------------------------------------------------------
// 登録するグローバルコマンドの設定
const globalCommands = [
    {
        name: 'register-guild-commands',
        description: 'コマンドをこのサーバに登録します',
    },
    {
        name: 'delete-guild-commands',
        description: 'このボットがサーバに登録したコマンドを削除します',
    },
];

//----------------------------------------------------------
// コマンドを全削除する関数
async function deleteCommands() {
    await deleteAllGlobalCommands();    // 既存のグローバルコマンドを全て削除
    await deleteAllGuildCommands();     // サーバのコマンドを全て削除
}

//----------------------------------------------------------
// グローバルコマンドを全削除する関数
async function deleteAllGlobalCommands() {
    try {
        const existingCommands = await rest.get(Routes.applicationCommands(clientId));

        if (existingCommands.length > 0) {
            console.log('既存のグローバルコマンドを削除しています...');

            for (const command of existingCommands) {
                await rest.delete(Routes.applicationCommand(clientId, command.id));
                console.log(`グローバルコマンド '${command.name}' (ID: ${command.id}) を削除しました。`);
            }
        }
        else {
            console.log('削除するグローバルコマンドはありません。');
        }
    }
    catch (error) {
        console.error('グローバルコマンドの削除に失敗しました:', error);
    }
}

//----------------------------------------------------------
// ボットに登録されているサーバのコマンドを全削除する関数
async function deleteAllGuildCommands() {
    try {
        const existingGuildCommands = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    
        if (existingGuildCommands.length > 0) {
            console.log('既存のギルドコマンドを削除しています...');
            for (const command of existingGuildCommands) {
                await rest.delete(Routes.applicationGuildCommand(clientId, guildId, command.id));
                console.log(`ギルドコマンド '${command.name}' (ID: ${command.id}) を削除しました。`);
            }
        }
        else {
            console.log('削除するギルドコマンドはありません。');
        }
    }
    catch (error) {
        console.error('ギルドコマンドの削除に失敗しました:', error);
    }
}

//----------------------------------------------------------
// 新しいグローバルコマンドを登録する関数
async function registerGlobalCommands() {
    try {
        console.log('新しいグローバルコマンドを登録しています...');
        await rest.put(Routes.applicationCommands(clientId), {
            body: globalCommands,
        });
        console.log('グローバルコマンドが正常に登録されました。');
    }
    catch (error) {
        console.error('グローバルコマンドの登録に失敗しました:', error);
    }
}

//----------------------------------------------------------
// コマンドを確認する
async function viewCommands() {
    await checkGlobalCommands();     // グローバルコマンドの再確認
    await checkGuildCommands();      // ギルドコマンドの再確認
}

//----------------------------------------------------------
// グローバルコマンドのリストを再取得
async function checkGlobalCommands() {
    try {
      const commands = await rest.get(Routes.applicationCommands(clientId));
      console.log('現在のグローバルコマンド:', commands);
    } catch (error) {
      console.error('コマンドの取得に失敗しました:', error);
    }
}

//----------------------------------------------------------
// ギルドコマンドのリストを再取得
async function checkGuildCommands() {
    try {
      const commands = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
      console.log('現在のギルドコマンド:', commands);
    } catch (error) {
      console.error('コマンドの取得に失敗しました:', error);
    }
}

//----------------------------------------------------------
// 不要なコマンドを全削除し、その後新しいコマンドを登録する処理
(async () => {
    // 処理前のコマンド一覧確認
    await viewCommands();

    // 削除も同時に行う場合は、コメントアウトを起こす
    //await deleteCommands();

    // コマンドの登録
    // await registerGlobalCommands();

    // 処理後のコマンド一覧確認
    // await viewCommands();
})();
