# Quiet Camera

写真と動画をブラウザ内だけで処理する、プライバシー重視のカメラPWAです。撮影データは自動送信されず、広告・解析・アカウント機能もありません。

## 主な機能

### 写真

- 前面／背面カメラ切替
- 0秒・3秒・10秒セルフタイマー
- 4:3・1:1・16:9の比率切替
- JPEG・PNG・WebP・PDF出力
- 複数写真をまとめた複数ページPDF
- `ImageCapture.takePhoto()`による高解像度撮影とCanvasフォールバック
- タップフォーカス要求とGalaxy等での自動AFフォールバック
- `object-fit: cover`を考慮したタップ座標補正
- ズーム、露出補正、ライト（対応端末）
- 自撮りの鏡像保存切替
- 撮影後確認の「毎回・2秒・なし」

### 動画

- MP4またはWebMの自動選択
- マイクOFF／ON（初期値は毎回OFF）
- 自動・720p・1080p
- 自動・30fps・60fps
- 軽量・標準・高画質
- 5分・10分・20分の録画上限
- 実FPSを考慮したビットレート設定
- 録画時間、推定容量、音声状態の表示
- 録画チャンクをIndexedDBへ順次退避
- 中断された録画の次回起動時復元
- 保存容量に応じた自動停止

### 履歴と復元

- 写真と動画をIndexedDBへ端末内保存
- 次回起動時の履歴復元
- レスポンシブな写真・動画ビューア
- 複数選択、選択削除、複数ページPDF作成
- スマートフォンでは下部シート、PCでは2カラム表示

### PWA

- インストール可能
- オフラインでアプリ画面を起動
- 新しいService Workerの更新通知
- 独立したプライバシーポリシー

## プライバシー設計

- 写真・映像・音声を自動アップロードしない
- マイク権限は動画設定をONにした場合だけ要求
- マイク設定は再起動時に必ずOFFへ戻す
- 位置情報を取得しない
- アクセス解析、広告SDK、ログイン、クラウド保存を使用しない
- 撮影結果と録画一時データはIndexedDBへ保存し、履歴から削除可能

## ローカルで確認

カメラ機能はHTTPSまたは`localhost`で動作します。

```bash
python -m http.server 8000
```

その後、`http://localhost:8000`を開きます。

## GitHub Pagesで公開

1. GitHubの **Settings → Pages** を開く
2. **Deploy from a branch** を選ぶ
3. `main`ブランチの`/ (root)`を指定して保存する
4. Android ChromeとiPhone Safariで実機検証する
5. 問題がなければ公開URLをTSUKUTTAへ登録する

```text
https://tomoponz.github.io/quiet-camera/
```

## 既知の制約

- Galaxy S25を含む一部Android端末では、Chromeが位置指定フォーカスAPIを公開しません。この場合は端末の連続オートフォーカスへフォールバックします。
- 位置指定AF、ズーム、露出、ライト、60fps、1080pは端末とブラウザの対応状況に依存します。
- 録画中のチャンクはIndexedDBへ退避しますが、録画終了時のファイル結合には一時的なメモリが必要です。
- 標準カメラアプリ固有のHDR、夜景合成、手ぶれ補正を完全には再現できません。
- iPhoneでは共有シートから「画像を保存」または「ファイルに保存」を選ぶ方法が確実です。
- サイトデータを消去するとアプリ内履歴も削除されます。

## 検証

```bash
node tests/validate.mjs
node --check storage.js
node --check core.js
node --check photo.js
node --check video.js
node --check ui.js
node --check service-worker.js
```

## 利用上の注意

人物や私有地を撮影・録画するときは、相手の同意と撮影場所の規則を守ってください。無断撮影、盗撮、撮影禁止場所での使用など、違法・迷惑な撮影や録画には使用しないでください。

## License

MIT License
