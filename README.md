# pdf-element-disabler

PDFをブラウザで開き、クリックしたテキスト要素やドラッグした範囲を一時的に非表示にする静的Webツールです。

デモ: GitHub Pages を有効化すると `https://kain18915.github.io/pdf-element-disabler/` で公開できます。

このリポジトリへ反映するには、ローカルで `main` に push してください。Cloud Agent からは `pdf-element-disabler` への書き込み権限がないため、次のエクスポートブランチから取り込めます。

```bash
git clone https://github.com/KAIN18915/pdf-element-disabler.git
cd pdf-element-disabler
git remote add export https://github.com/KAIN18915/report_ee_experiment_electricdevices.git
git fetch export cursor/pdf-element-disabler-export-25aa
git checkout export/cursor/pdf-element-disabler-export-25aa -- index.html app.js styles.css README.md
git commit -m "Add PDF element disabler viewer"
git push origin main
```

## 使い方

1. `index.html` をブラウザで開くか、GitHub Pages の URL にアクセスします。
2. `PDFを選択` からローカルPDFを開くか、リポジトリルートに `main.pdf` を置いたうえで `サンプルPDFを開く` を使います。
3. `テキストクリック` モードでは、PDF上のテキスト要素をクリックすると白いマスクで隠します。
4. `範囲ドラッグ` モードでは、画像や図を含む任意の範囲をドラッグして隠します。
5. 必要に応じて `印刷 / PDF保存` からブラウザの印刷機能で保存します。

## GitHub Pagesで公開する

ビルドは不要です。リポジトリの **Settings → Pages** で、Source を **Deploy from a branch**、Branch を `main`、フォルダを `/ (root)` に設定してください。

PDF.js は CDN から読み込みます。オフライン配信したい場合は `pdfjs-dist` の `pdf.mjs` と `pdf.worker.mjs` を同梱し、`app.js` の import 先をローカルに変更してください。

## ホスティング方針

- **GitHub Pages（推奨）**: 静的ファイルのみで動作します。
- **Netlify / Vercel / Cloudflare Pages**: 同じファイルをそのまま配信できます。
- **独自サーバー**: 必須ではありません。サーバー側でPDFを保存・処理したい場合のみ検討してください。

## 注意

非表示は画面表示と印刷用の白いマスクです。PDF内の元データを削除するものではありません。機密情報の完全な墨消しには、専用のPDF編集ツールを使ってください。
