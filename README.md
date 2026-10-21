# Discord Bot
Discord で動作する bot

基本的には常駐して、configに定義されたチャンネルのログを監視することによって動作する

・メッセージ掃除機能
configに定義された時間が経過したメッセージを削除する
（メッセージイベントを取得し、メッセージ削除ジョブを登録している）

・メッセージ削除非対称機能
configに設定された絵文字を含むメッセージは削除機能の対象外にする

・ログ機能
configに設定されたログチャンネルに、削除対象メッセージログを保存する
（テスト中の結果を確認しやすいように）

・代理投稿機能
ボット宛にメッセージを送信した際、ボットは元のメッセージを削除し、同様の内容を代理で投稿する。

## 削除キューの永続ストレージ
削除対象のメッセージID、チャンネルID、送信時刻、削除予定時刻は、Node.js組み込みのSQLite (`node:sqlite`) に保存されます。既定の保存先は `./data/deletion-queue.sqlite` です。Node.js v24.22.1以上が必要です。

デプロイ環境では、再起動後も保持される永続ボリュームをマウントし、`DELETION_DB_PATH` にそのボリューム上のDBファイルパスを設定してください。例: `/var/data/deletion-queue.sqlite`。Botは起動時と30秒ごとに期限切れのメッセージを最大25件ずつ処理します。

## コンテナで起動
Docker EngineとDocker Composeが利用できる環境では、プロジェクトルートで次を実行するとビルドと起動を行います。

```sh
docker compose up --build -d
```

Composeは `.env` からBotの認証情報を読み込み、`deletion-data` ボリュームにSQLite DBを保存します。DBを含むボリュームを削除しないよう、通常の停止には `docker compose down -v` ではなく `docker compose down` を使用してください。

Docker対応のホスティングサービスでは、このリポジトリのDockerfileを指定してデプロイできます。サービス側には `DISCORD_TOKEN` を秘密環境変数として設定し、永続ディスクを `/data` にマウントしてください。Node.jsとnpm依存関係はイメージに含まれます。NodeイメージはNode v24.22.1を使用し、`node_modules` と `.env` はイメージへコピーされません。