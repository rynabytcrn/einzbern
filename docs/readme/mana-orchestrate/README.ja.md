<div align="center">

# Mana Orchestrate

聖杯は願いを叶える。Mana Orchestrate（マナ・オーケストレート）は、魔力を正しい瞬間に正しい場所へ流す。

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[やることは三つ](#やることは三つ) · [インストール](#インストール) · [入れたあと](#入れたあと) · [バージョン](#バージョン) · [中身](#中身)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate` のあと、プロジェクトでホストに「Einzbern をインストールして」と言う。

---

Einzbern（アインツベルン）を Claude Code と Codex に接続するスキルだ。Einzbern はその二つのホストのためのプロジェクト記憶で、作業項目、知識、議事録が、必要になるプロンプトの前にモデルの前へ現れる。Mana は巡る記憶、Orchestrate はそれをいつどこへ流すかの指揮。このスキルはモデルにエンジンのどの機能をいつ呼ぶかを教え、インストールウィザードを同梱する。

## やることは三つ

**Einzbern を入れる。** ホストに「Einzbern をインストールして」と言えば、ウィザードが引き継ぐ。一画面の質問、一度の確認、エンジンのダウンロードと検証、フックの配線。二つのホストを一度に済ませる。

**いつ何をするかをモデルに教える。** ナビゲーション表が一枚。始める前に記憶を取り、終えたら結果を作業項目に書き戻し、決定があれば議事録に、教訓があればカードに書く。表はエンジンが自分のバージョンに合わせて生成するので、モデルが読む動詞はエンジンの動詞と一対一で対応する。

**自分では何も持たない。** データも、ルールも、設定もない。記憶はプロジェクトの `.ether`（エーテル、記録が形を保つ場所）に、原則と変数は Atelier（アトリエ、魔術師の工房。ここではローカルの管理ページ）にある。このスキルはその表とそのウィザードでしかない。

## インストール

skills コマンドで：

```
npx skills add tpmoonchefryan/mana-orchestrate
```

あるいはホストに言う。Mana Orchestrate というスキルを探して入れて。

置き場所はホストの skills ディレクトリ。Claude Code は `~/.claude/skills`、Codex は `~/.agents/skills`。次にプロジェクトのディレクトリで言う。Einzbern をインストールして。

ウィザードが尋ねるのは、新規か既存の `.ether` からの復元か、生成物をどこに置くか、そこがクラウド同期フォルダか、言語は何か、AGENTS.md にナビゲーション節を書くか。最後に書き込む予定のファイルを全部列挙し、あなたが一度だけ確認する。エンジンはこのスキルと同じバージョンのリリースからダウンロードされ、ダイジェストを検証してから配置される。ローカルのアーカイブがあればオフラインでも入る。

その後のことはすべて同じウィザードのモードだ。更新、修復、TCRN Workflow からの移行、アンインストール、健全性チェック。「Einzbern を更新して」と言えばよい。

コミットもプッシュもしない。あなたの .gitignore を書き換えず、何も削除せず、エンジンのダウンロード以外でネットワークに触れない。

## 入れたあと

あなたは普段どおり仕事をする。毎回のプロンプトの前にホストがそれをエンジンに渡して一度検索し、強く関係する見出しがあればコンテキストに入り、なければ何も起きない。モデルはナビゲーション表に従って正しい瞬間に記録する。見たいとき、変えたいときは Atelier を開く。

## バージョン

Einzbern と同じバージョン番号、同じリリース。現在は {{version}}。この README と SKILL.md のナビゲーション表は Einzbern のリリース時に生成される。このリポジトリでは文書を手で編集しない。

## 中身

- `SKILL.md`：ナビゲーション表と三段階の手順。日々のセッションが読み込むのはこれだけ。
- `references/`：インストール、復元、更新、移行、アンインストール、健全性チェックのウィザード文。インストール時にだけ読み込まれる。

## ドキュメント

Einzbern の README と Wiki。

## ライセンス

Apache-2.0
