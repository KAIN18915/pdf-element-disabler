# pdf-element-disabler（穴埋め解除ビューア）

先生が穴埋め問題を作るために、答えの上に **白い長方形** を乗せたり、答えを **白文字（背景と同じ色で見えない文字）** にして隠しているPDFを、ブラウザ内で元に戻して答えを表示する静的Webツールです。

PDFはどこにもアップロードされず、すべての処理はブラウザ内で完結します。

デモ: GitHub Pages を有効化すると `https://kain18915.github.io/pdf-element-disabler/` で公開できます。

このリポジトリへ反映するには、ローカルで `main` に push してください。Cloud Agent からは `pdf-element-disabler` への書き込み権限がないため、次のエクスポートブランチから取り込めます。

```bash
git clone https://github.com/KAIN18915/pdf-element-disabler.git
cd pdf-element-disabler
git remote add export https://github.com/KAIN18915/report_ee_experiment_electricdevices.git
git fetch export cursor/reveal-hidden-answers-df0d
git checkout export/cursor/reveal-hidden-answers-df0d -- index.html app.js styles.css README.md
git commit -m "Add fill-in-the-blank reveal viewer"
git push origin main
```

## 使い方

1. `index.html` をブラウザで開くか、GitHub Pages の URL にアクセスします。
2. `PDFを選択` からローカルPDFを開くか、リポジトリルートに `main.pdf` を置いたうえで `サンプルPDFを開く` を使います。
3. **白い被せ物（長方形）を消す**
   - `白い被せ物をすべて消す` をオンにすると、答えを覆っている白い長方形がすべて消え、下の文字が見えます。
   - 1つずつ消したいときは、PDF上の白い長方形にカーソルを重ねて枠が出た所をクリックします。もう一度クリックすると元に戻ります。
4. **白文字を見えるようにする**
   - `白文字に色を付ける` をオンにすると、白い（見えない）文字に色が付いて読めるようになります。
   - `表示する色` で好きな色に変更できます。
5. うまく消えない / 色が付かないときは、`感度（白とみなす明るさ）` を下げて、薄いグレーなども対象にしてください。
6. 必要に応じて `編集済みPDFをダウンロード` で、画面上の編集内容を反映したPDFファイルを保存します。

## 仕組み

PDF.js はPDFの内容をすべて 2D canvas に描画します。本ツールはその描画処理に割り込み、

- **白に近い塗りつぶし**（答えを隠す被せ物）→ 描画をスキップして下の文字を見えるようにする
- **白に近い文字**（白文字）→ 指定した色に変えて描画する

ことで、隠された答えを復元します。

## GitHub Pagesで公開する

ビルドは不要です。リポジトリの **Settings → Pages** で、Source を **Deploy from a branch**、Branch を `main`、フォルダを `/ (root)` に設定してください。

PDF.js と pdf-lib は CDN から読み込みます。オフライン配信したい場合は各ライブラリを同梱し、`app.js` の import 先をローカルに変更してください。

## 制限事項

- 答えが **画像**（白い画像や図形画像）で隠されている場合や、透明グループを多用した複雑なPDFでは、被せ物を検出できないことがあります。
- 白文字の復元は、フォントとして描画された文字が対象です。アウトライン化された（図形になった）文字には効かない場合があります。
- ダウンロードされるPDFは、各ページを画像として再構成したものです。元PDFのテキストやベクター情報は保持されません。
