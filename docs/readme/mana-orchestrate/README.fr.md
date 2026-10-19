<div align="center">

# Mana Orchestrate

Le Graal exauce les vœux ; Mana Orchestrate fait couler le mana au bon endroit, au bon moment.

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Français**

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[Il fait trois choses](#il-fait-trois-choses) · [Installation](#installation) · [Une fois en place](#une-fois-en-place) · [Version](#version) · [Ce qu'il contient](#ce-quil-contient)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate`, puis dites à votre hôte « installe Einzbern » dans le projet.

---

C'est le skill qui amène Einzbern dans Claude Code, Codex et DeepSeek Harness. Einzbern est la mémoire de projet de ces trois hôtes : éléments de travail, connaissances et comptes rendus apparaissent devant le modèle avant le prompt qui en a besoin. Le mana est la mémoire en circulation ; orchestrer, c'est décider quand elle coule et vers où. Ce skill apprend au modèle quand appeler quelle fonction du moteur, et embarque l'assistant d'installation.

## Il fait trois choses

**Il fait entrer Einzbern.** Vous dites à votre hôte « installe Einzbern » et l'assistant prend la main : un écran de questions, une confirmation, moteur téléchargé et vérifié, hook branché, les deux hôtes réglés en une passe.

**Il dit au modèle quand faire quoi.** Une table de navigation : rappeler la mémoire avant de commencer, reporter le résultat dans l'élément de travail une fois fini, noter les décisions en comptes rendus, écrire les leçons en cartes. Le moteur génère la table pour sa propre version, si bien que chaque verbe lu par le modèle correspond à un verbe du moteur.

**Il ne détient rien.** Ni données, ni règles, ni configuration. La mémoire vit dans la bibliothèque partagée `Ether`, sous un dossier parent choisi par l’utilisateur ; les projets sont séparés par leur identité et les bibliothèques de projet `.ether` existantes restent utilisables. Les principes et les variables vivent dans Atelier, l’atelier d’un mage, ici la page de gestion locale. Le skill n’est que cette table et cet assistant.

## Installation

Avec la commande skills :

```
npx skills add tpmoonchefryan/mana-orchestrate
```

Ou dites à votre hôte : trouve un skill nommé Mana Orchestrate et installe-le.

Il se place dans le répertoire des skills de l'hôte, `~/.claude/skills` pour Claude Code et `~/.agents/skills` pour Codex et DeepSeek Harness. Dans DeepSeek Harness, le rappel avant chaque prompt passe par le plugin dsh-mana-orchestrate ; aucun fichier de hook n'est écrit. Puis, dans le répertoire du projet, dites : installe Einzbern.

L’assistant demande : installation neuve ou restauration depuis une bibliothèque existante, où placer `Ether`, si ce dossier est synchronisé dans le cloud, quelle langue, et s’il faut écrire une section de navigation dans AGENTS.md. `Ether` est le nom du dossier ; vous choisissez son parent sur un disque local, externe ou dans un dossier synchronisé. Les projets suivants réutilisent par défaut cet emplacement enregistré. Il liste ensuite chaque fichier qu’il s’apprête à écrire, et vous confirmez une seule fois. Le moteur est téléchargé depuis la release qui porte la même version que ce skill et vérifié contre son empreinte avant d’être posé ; avec une archive locale, il s’installe hors ligne.

Tout ce qui suit est un mode du même assistant : mise à jour, réparation, migration depuis TCRN Workflow, désinstallation, bilan de santé. Dites « mets à jour Einzbern », et c'est tout.

Il ne commite pas, ne pousse pas, ne modifie pas votre .gitignore, ne supprime rien, et ne touche au réseau que pour télécharger le moteur.

## Une fois en place

Vous travaillez comme d'habitude. Avant chaque prompt, l'hôte le confie au moteur pour une recherche ; les titres fortement liés entrent dans le contexte, sinon il ne se passe rien. Le modèle note aux bons moments, en suivant la table de navigation. Pour voir ou changer quelque chose, ouvrez Atelier.

## Version

Même numéro de version qu'Einzbern, même release. Actuellement {{version}}. Ce README et la table de navigation de SKILL.md sont générés à la release d'Einzbern ; dans ce dépôt, les documents ne sont pas modifiés à la main.

## Ce qu'il contient

- `SKILL.md` : la table de navigation et la routine en trois temps. Les sessions ordinaires ne chargent que ce fichier.
- `references/` : les textes de l'assistant pour l'installation, la restauration, la mise à jour, la migration, la désinstallation et le bilan de santé. Chargés seulement pendant l'installation.

## Documentation complète

Le README et le Wiki d'Einzbern.

## Licence

Apache-2.0
