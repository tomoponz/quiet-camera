# 構成と処理の流れ

[READMEへ戻る](../README.md)

この資料は、2026年10月31日に構成を整理したmainのソースを読み始めるための案内です。コード上の役割分担と処理の流れを説明しており、自動試験の結果や実機での動作確認とは区別しています。確認範囲は[検証記録](verification.md)、利用者向けの操作手順は[使い方](usage.md)を参照してください。

## 全体像

Quiet CameraはHTML・CSS・JavaScriptで構成されたブラウザーアプリです。`index.html` が画面構造を定義し、複数のJavaScriptファイルを順番に読み込みます。カメラ映像の取得、録画、保存領域の管理、ファイル共有にはブラウザーAPIを使用しています。PWA用のマニフェストとService Workerも含まれています。

HTMLはボタンや設定欄などの構造と意味、CSSはレイアウト・配色・縦横表示の見た目、JavaScriptは操作に応じた状態変更とAPI呼び出しを担当します。CSSで画面上の映像の見せ方を変える処理と、保存されるファイル自体の画素を加工する処理は別です。写真ではCanvasを使って表示枠の保存範囲を切り出し、動画では取得したストリームを `MediaRecorder` に渡して記録します。

実装の根拠：[画面とスクリプトの読み込み順](../index.html)、[写真の出力](../assets/js/photo.js)、[録画の開始](../assets/js/video.js)。

## ファイルの配置

```text
quiet-camera/
├── index.html             画面の入口
├── privacy.html           プライバシー説明
├── service-worker.js      PWAの更新とキャッシュ
├── manifest.webmanifest   PWAの定義
├── assets/
│   ├── js/                撮影・保存・画面操作の処理
│   └── css/               画面のスタイル
├── icons/                 アプリアイコン
├── images/                紹介画像
├── docs/                  使い方・構成・確認範囲
├── tests/                 単体試験と合成メディアによる試験
└── .github/workflows/     CIの実行定義
```

Service Workerは公開URL全体を扱えるようルートに残しています。撮影データはこのファイル階層に保存されるわけではなく、ブラウザー内のIndexedDBに保存されます。

## 主要ファイル

本文中のソースへのリンクは、この文書と同じ版のファイルを指します。過去の確認記録と対象コミットは[検証記録](verification.md)に分けて記載しています。

| ファイル | 主な役割 |
| --- | --- |
| [`index.html`](../index.html) | 撮影画面、設定、履歴、確認ダイアログの構造とスクリプトの読み込み順。 |
| [`core.js`](../assets/js/core.js) | DOM要素の参照、共有状態、初期設定、撮影モード、比率、基本UIの管理。 |
| [`camera-devices.js`](../assets/js/camera-devices.js) | カメラ・マイクの取得要求、カメラ一覧の取得、起動・切替・失敗時の処理。 |
| [`camera-controls.js`](../assets/js/camera-controls.js) | ズーム、ピント、露出補正、ライトの要求と対応機能の確認。 |
| [`camera-enhancements.js`](../assets/js/camera-enhancements.js) | カメラの設定イベントと、設定・履歴コントローラーの接続。 |
| [`settings-sheet.js`](../assets/js/settings-sheet.js) | 設定パネルの配置・開閉・フォーカス・ドラッグ操作、プレビュー内の表示位置調整。 |
| [`gallery-loader.js`](../assets/js/gallery-loader.js) | 履歴のページ読込・追加読込・スクロール位置の復元。 |
| [`bootstrap.js`](../assets/js/bootstrap.js) | 全機能の読み込み後に、Service Worker登録とアプリ初期化を1回開始。 |
| [`camera-transition.js`](../assets/js/camera-transition.js) | カメラ切替時の一時表示、操作の抑止、ストリームを再利用できる条件の判定。 |
| [`photo.js`](../assets/js/photo.js) | 写真の取得・切り出し・画像形式変換、PDF作成、確認対象の切替。 |
| [`video.js`](../assets/js/video.js) | 録画、容量・時間の制限、一時データの管理、保存確定、中断録画の復元処理。 |
| [`storage.js`](../assets/js/storage.js) | IndexedDBの撮影データと録画断片、設定保存、保存容量の問い合わせ。 |
| [`ui.js`](../assets/js/ui.js) | アプリ初期化、共有・ダウンロード・削除、Service Workerの登録。 |
| [`photo-review.js`](../assets/js/photo-review.js) | 詳細画面での写真・動画の前後移動とスワイプ操作。 |
| [`gallery-selection.js`](../assets/js/gallery-selection.js) / [`gallery-batch.js`](../assets/js/gallery-batch.js) | 履歴の複数選択、一括での保存・共有・削除、ZIP生成。 |
| [`camera-overlay.js`](../assets/js/camera-overlay.js) / [`device-layout-model.js`](../assets/js/device-layout-model.js) | 端末の向きと表示領域に応じた、映像枠や操作部の位置計算。 |
| [`camera-overlay.css`](../assets/css/camera-overlay.css) / その他のCSS | 計算された位置の画面反映、撮影画面・設定・履歴のスタイル定義。 |
| [`service-worker.js`](../service-worker.js) / [`manifest.webmanifest`](../manifest.webmanifest) | アプリ資材のキャッシュとPWA定義（撮影履歴の保存先とは別）。 |

各スクリプトはES Modulesとして分離されておらず、`elements`、`state`、`QuietCameraEnhancements` などをグローバル領域を介して共有するため、読み込み順に意味があります。`core.js` のカメラ操作と `ui.js` の履歴操作は、最初から対応する現行処理へ委譲する固定の入口です。後から関数やクリックハンドラーを差し替える方式は取り除きました。`camera-enhancements.js` が設定・履歴のコントローラーを接続し、最後に `bootstrap.js` がアプリ初期化を開始します。画面イベントは元の登録順を維持しているため、今後の変更でも読み込み順を確認してください。また、`camera-capture.js` は写真処理を接続する薄い窓口であり、撮影処理の本体は `photo.js` にあります。

現在の入口：[カメラ操作](../assets/js/core.js)、[設定・履歴の接続](../assets/js/camera-enhancements.js)、[起動](../assets/js/bootstrap.js)。写真処理の根拠：[写真処理の接続](../assets/js/camera-capture.js)。

## 撮影から保存まで

```mermaid
flowchart TD
    A[利用者がカメラを許可] --> B[getUserMediaで映像を取得]
    B --> C[MediaStreamをvideo要素に表示]
    C --> D{撮影モード}
    D -->|写真| E[ImageCapture またはプレビューの1フレーム]
    E --> F[Canvasで切り出し・鏡像・形式変換]
    F --> G[写真のBlobと情報をIndexedDBに保存]
    D -->|動画| H[MediaRecorderで録画]
    H --> I[断片と録画セッションをIndexedDBに保存]
    I --> J[停止後に書き込み完了と読み込み可否を確認]
    J --> K[履歴情報を確定し録画断片を参照]
    G --> L[履歴から確認]
    K --> L
    L --> M[ブラウザーのダウンロードまたはOSの共有]
```

### 写真

`ImageCapture.takePhoto()` が利用可能であれば静止画を取得し、利用できない場合や失敗した場合は現在のプレビュー映像の1フレームから画像を作ります。画面の保存範囲に合わせて中央を切り出し、自撮りの鏡像設定を反映した後、Canvasから画像の `Blob` を生成します。実際の画像形式はブラウザーの対応に依存します。PDF選択時は画像をPDFに組み込みます。履歴（IndexedDB）への保存と、端末へのファイルダウンロードは別の処理です。

### 動画

動画への切り替え時に、`core.js` が手動OFFと今回の拒否状態を確認してマイク設定を決め、`camera-devices.js` が `getUserMedia()` で映像と必要な音声を取得します。ブラウザーの権限確認を使い、マイク拒否後にアプリ独自の確認ダイアログは重ねません。準備中は録画を開始できません。手動OFFは `localStorage` に保存し、次回起動でも維持します。

`MediaRecorder` にストリームを渡し、録画中に生成される断片（チャンク）をIndexedDBへ順次書き込みます。停止後は書き込みの完了を待ち、断片から組み立てた動画をブラウザーで読み込めるか確認したうえで履歴情報を確定します。この確認は読み込み可否のチェックであり、動画全編の再生品質や音声同期まで保証するものではありません。

確定した動画の履歴記録は、保存済みの断片を参照する形で保持し、大きな `Blob` の二重保存を避けています。閲覧やファイル取り出しの際には、断片から一時的に `Blob` を組み立てるため、メモリを使います。保存確定前に中断したデータには復元経路がありますが、保存できたデータや読み込み確認の結果によっては復元できません。容量制限、復元、一時データの扱いは[データと権限](data-and-permissions.md)にまとめています。

実装の根拠：[写真の取得と保存](../assets/js/photo.js)、[動画の読み込み確認](../assets/js/video.js)、[動画の保存確定](../assets/js/video.js)、[断片を使った読み出し](../assets/js/storage.js)、[履歴情報の確定](../assets/js/storage.js)。

## ブラウザーAPIとの分担

| API・仕組み | アプリでの用途 | 読むときの注意 |
| --- | --- | --- |
| `getUserMedia` / `MediaStreamTrack` | カメラ・マイク取得と画質・カメラ操作の要求 | 権限、対応機能、取得結果はブラウザーと端末に依存します。要求値がそのまま採用されるとは限りません。 |
| `HTMLVideoElement` | プレビュー表示、保存動画の確認 | プレビューが表示されても保存完了を意味しません。 |
| `ImageCapture` / Canvas / `Blob` | 写真の取得、画素の切り出し、ファイルデータ生成 | CSSで画面上の見え方を変える処理とは区別されます。 |
| `MediaRecorder` | 動画およびマイクON時の音声記録 | コンテナー、コーデック、品質などに環境差があります。 |
| IndexedDB | 履歴、録画断片、録画セッションの保存 | ブラウザーのサイトデータであり、端末の標準写真フォルダーとは別です。 |
| `localStorage` | 一部の撮影設定とカメラ識別子の保存 | 手動で選んだマイクOFFを維持します。マイクの権限自体はブラウザーが管理します。 |
| Web Locks | 録画データを扱う処理の排他制御・競合防止 | 安全な録画と復元に必須のAPIです。非対応環境では録画を開始しません。 |
| `navigator.share` / ダウンロードリンク | 撮影ファイルのアプリ外への取り出し | 保存先や共有先での処理はブラウザー・OS側が担います。 |
| Service Worker / Cache Storage | アプリのHTML・CSS・JavaScriptなどのキャッシュ | 撮影データを保存するIndexedDBとは別です。更新や通信の詳細は[データと権限](data-and-permissions.md)を参照してください。 |

実装の根拠：[データベース定義](../assets/js/storage.js)、[設定の保存](../assets/js/storage.js)、[Web Locksによる排他](../assets/js/video.js)、[取り出し](../assets/js/ui.js)。

## 読み始める順序

1. `index.html` で、画面上のボタンや設定欄の要素を確認します。
2. `assets/js/core.js` で各要素の参照と共有状態を確認し、`bootstrap.js` → `ui.js` の `initializeApp()` で起動の流れを追います。
3. `photo.js` で、1回の写真撮影が画像データに変換される流れを追います。
4. `storage.js` で、履歴への保存とファイル取り出しの違いを確認します。
5. `video.js` で、動画特有の断片保存と保存確定・復元処理を読みます。
6. 設定の開閉・配置は `settings-sheet.js`、履歴の読込は `gallery-loader.js`、画面への一覧描画や取り出し操作は `ui.js` を読みます。
7. カメラ固有の操作は `camera-devices.js` と `camera-controls.js`、画面の縦横レイアウトは `camera-overlay.js` と関連CSSへ進みます。

試験コードの読み方と実行済み範囲は[検証記録](verification.md)、開発に使ったAIなどの記録は[開発とAIの利用](development.md)を参照してください。
