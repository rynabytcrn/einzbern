<div align="center">

# Einzbern

Le Graal exauce les vœux. Einzbern se souvient des vœux que vous avez formulés, des décisions que vous avez prises et des pièges dans lesquels vous êtes tombé,<br>et les place devant le modèle juste avant le prompt qui en a besoin.

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Français**

![release](https://img.shields.io/badge/release-3.3.1-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

[Ce qui s'est passé mercredi après-midi](#ce-qui-sest-passé-mercredi-après-midi) · [Ce qu'il retient](#ce-quil-retient) · [Quand vous en aurez envie](#quand-vous-en-aurez-envie) · [Pourquoi lui, et pas un plugin de mémoire](#pourquoi-lui-et-pas-un-plugin-de-mémoire) · [Installation](#installation) · [Au quotidien](#au-quotidien) · [Plusieurs appareils et dossiers cloud](#plusieurs-appareils-et-dossiers-cloud) · [Comment nous l'utilisons nous-mêmes](#comment-nous-lutilisons-nous-mêmes) · [Comment les principes intégrés font durer vos tokens](#comment-les-principes-intégrés-font-durer-vos-tokens) · [Pourquoi cette conception](#pourquoi-cette-conception) · [Glossaire](#glossaire)

</div>

<table>
<tr>
<td align="center" width="33%">

### 1
hook<br><sub>une recherche avant chaque prompt, silence sans lien fort</sub>

</td>
<td align="center" width="33%">

### 0
dépendance à l'exécution<br><sub>un seul fichier sans dépendance, ni base de données, ni réseau</sub>

</td>
<td align="center" width="33%">

### 3
hôtes, une mémoire<br><sub>Claude Code, Codex et DeepSeek Harness lisent le même Ether</sub>

</td>
</tr>
</table>

> [!TIP]
> Inutile de tout lire d'abord. Ajoutez Mana Orchestrate, dites à votre hôte « installe Einzbern » dans le projet, et l'assistant pose ses questions sur un seul écran.

---

## Ce qui s'est passé mercredi après-midi

Lundi, dans Claude Code, vous avez tranché : le bouton de la page de connexion passe au nouveau composant du design system, et l'ancien style reste jusqu'à la 1.4.

Mercredi, dans Codex, vous dites « fais aussi la page d'inscription tant que tu y es ». Avant qu'il touche à quoi que ce soit, trois lignes sont déjà dans son contexte : la Story de lundi avec ses critères d'acceptation, la décision « l'ancien style reste jusqu'à la 1.4 », et une carte laissée la semaine dernière : ce composant a besoin d'une propriété supplémentaire sous Safari.

Vous n'avez rien collé, et vous ne lui avez pas rappelé d'aller vérifier. C'est tout ce que fait Einzbern : noter, et ressortir au bon moment.

## Une machine à vœux

Le Graal est une machine à vœux : on formule un vœu, on obtient un résultat. Les machines à vœux ont un point commun : un vœu formulé vaguement a de fortes chances de se réaliser autrement que vous ne le vouliez.

Einzbern suit ce principe. Il n'impose que deux choses : un élément de travail doit énoncer son objectif, et ce qui compte comme terminé. Comment l'écrire, le découper, le mener, c'est au modèle d'en décider selon sa propre logique. Einzbern ne s'en mêle pas.

Éléments de travail, connaissances, comptes rendus et variables sont le mana qui circule dans cette machine. Ils sont fixés dans une bibliothèque partagée à l’emplacement de votre choix, nommée `Ether`, d'après l'éther, le milieu qui permet au mana de prendre forme dans le monde réel. Le modèle y puise avant chaque prompt et y dépose ce qu'il a fait.

## Ce qu'il retient

**Les vœux : les éléments de travail.** Quatre niveaux : Initiative, Epic, Story, Subtask. La Story est la plus petite intention complète, et c'est le seul niveau indexé. Les relations entre éléments sont des champs, pas de la prose : qui bloque qui, qui réalise quoi, qui remplace quoi, quel compte rendu l'a décidé.

> Story : passer le bouton de connexion au composant du DS. Acceptation : les états normal, survol et désactivé correspondent au Storybook.

**Les décisions : les comptes rendus.** Vos décisions, et les décisions techniques prises par le modèle. Chaque décision porte un numéro ; les éléments de travail et les cartes la citent par ce numéro. On ne demande pas au modèle de tenir des réunions, seulement de noter.

> Compte rendu D3 : conserver l'ancien style de bouton jusqu'à la 1.4, le retirer en 1.5.

**Les pièges : les connaissances.** Une carte contient un fait sur l'environnement ou une leçon : le genre de chose qu'aucun élément de travail ni compte rendu ne porte comme champ. Le modèle décide de ce qui mérite d'être gardé, et une carte est consultable dès qu'elle est écrite. Une ancienne carte n'est retirée que lorsqu'une nouvelle la contredit. L'ancienneté n'est pas une raison, la capacité non plus.

> Carte : le bouton du DS a besoin de appearance: none sous Safari, sinon les coins arrondis disparaissent.

**Les variables.** Le tableau des paliers de modèles par hôte, l'adresse du design system du projet, et les paires clé-valeur que vous définissez vous-même. Elles sont rendues dans AGENTS.md : si vous y écrivez « l'implémentation utilise le palier principal », Claude Code et Codex traduisent chacun vers leur propre modèle.

## Comment cela arrive devant le modèle

Avant l'envoi de chaque prompt, l'hôte le confie au moteur pour une recherche. S'il existe quelque chose de fortement lié, son titre entre dans le contexte :

```
[Story terminée] Bouton de connexion passé au composant DS · Acceptation : trois états conformes au Storybook
[Compte rendu D3] Ancien style de bouton conservé jusqu'à la 1.4, retiré en 1.5
[Carte] Le bouton DS a besoin de appearance: none sous Safari
```

S'il n'y a rien de fortement lié, il ne se passe rien. Le modèle va chercher lui-même le texte complet quand il en a besoin. Une fois une tâche terminée, le modèle reporte le résultat dans l'élément de travail, note la décision s'il y en a une, et écrit une carte s'il y a une leçon.

## Quand vous en aurez envie

- Une tâche s'étale sur trois jours et cinq sessions, et le modèle du quatrième jour sait encore ce qui a été décidé le premier.
- Vous alternez entre Claude Code, Codex et DeepSeek Harness et voulez qu'ils lisent tous la même mémoire.
- Un lot tourne sans surveillance pendant la nuit, et le matin vous pouvez retracer ce que chaque étape a fait et sur quelle décision elle s'appuyait.
- Le poste fixe continue de travailler pendant que vous sortez avec le portable et reprenez là où vous en étiez.

Conçu pour une personne et plusieurs appareils. Le partage d'une mémoire entre plusieurs personnes n'est pas réalisé.

## Pourquoi lui, et pas un plugin de mémoire

La plupart des solutions de mémoire sont un magasin de vecteurs ou une pile de notes : elles enregistrent des fragments de conversation et les repêchent par similarité. Elles retiennent ce qui a été dit. Einzbern retient ce qui a été décidé, ce qui est à faire et ce qui a été appris, trois sortes d'enregistrements qui ont chacune leur structure et se citent par numéro.

| Ce dont vous avez besoin | Un plugin de mémoire | Einzbern |
|---|---|---|
| Une décision et son origine | Un fragment de conversation similaire | Des comptes rendus numérotés ; éléments de travail et cartes pointent vers eux par numéro |
| Où en est un travail | Rien | Quatre niveaux d'éléments ; les relations sont des champs : qui bloque quoi, qui remplace quoi, quel compte rendu l'a décidé |
| Changer d'hôte | Chacun garde sa mémoire | Claude Code, Codex et DeepSeek Harness lisent le même Ether |
| Changer d'appareil | Synchronisation manuelle, ou aucune | Dans un dossier cloud ; un flux par appareil ; écrire en même temps ne crée aucun conflit |
| Voir et changer | Ouvrir des fichiers | Atelier : variables, règles, configuration des portes et état du dépôt sur une seule page ; un changement est rendu aussitôt dans AGENTS.md |
| La façon de travailler du modèle | Pas l'affaire du plugin | Non policée ; sept principes, désactivés par défaut, choisis projet par projet |
| L'enregistrement peut-il être falsifié | Oui | Une chaîne de hachage en ajout seul ; modifiez une entrée et tout ce qui suit cesse de correspondre |

Les variables sont l'autre moitié qui le distingue : le tableau des paliers de modèles par hôte, l'adresse du design system, vos propres paires clé-valeur, tous édités dans Atelier et rendus dans AGENTS.md, si bien qu'un même texte de règle se traduit sur chaque hôte vers ses propres modèles.

## Installation

Einzbern arrive par un skill : Mana Orchestrate. Le mana est la mémoire en circulation ; orchestrer, c'est décider quand elle coule et vers où. Ce skill apprend au modèle quand appeler quelle fonction du moteur, et embarque l'assistant d'installation.

Installez-le avec la commande skills :

```
npx skills add tpmoonchefryan/mana-orchestrate
```

Ou dites à votre hôte : trouve un skill nommé Mana Orchestrate et installe-le.

Puis, dans le répertoire du projet, dites : installe Einzbern. L'assistant pose ses questions sur un seul écran : installation neuve ou restauration depuis un `Ether` existant, où placer les artefacts, si ce dossier est synchronisé dans le cloud, quelle langue, et s'il faut écrire une section de navigation dans AGENTS.md. Il liste ensuite chaque fichier qu'il s'apprête à écrire, et vous confirmez une seule fois. Mise à jour, réparation, migration depuis la version précédente, désinstallation et bilan de santé sont des modes du même assistant.

Il ne commite pas, ne pousse pas, ne modifie pas votre .gitignore, ne supprime rien, et ne touche au réseau que pour télécharger le moteur.

## Au quotidien

Vous travaillez comme d'habitude. La mémoire apparaît d'elle-même.

Quand vous voulez voir ou changer quelque chose, ouvrez Atelier. L'atelier d'un mage ; ici, une page web sur votre machine : quels principes sont activés, quelles sont les variables, comment les portes sont configurées, dans quel état est le dépôt de mémoire. Il n'est pas résident ; ouvrez-le quand vous en avez besoin.

AGENTS.md vous appartient. Einzbern n'y écrit que des sections balisées : les principes que vous avez activés et les variables rendues pour le modèle. Dès que vous modifiez une section, il cesse de la réécrire, et vous choisissez dans Atelier la suite à donner.

Il y a sept principes intégrés, appelés Command Spells, les sceaux de commandement auxquels un Servant ne peut se soustraire. Ils ne sont pas obligatoires : tous sont désactivés par défaut, vous les activez projet par projet dans Atelier, et la mémoire fonctionne de la même façon sans eux.

- Fonctionnement autonome : pas de « je continue ? » en cours de tâche ; les actions réversibles se font simplement ; seules les actions destructrices et les changements de périmètre arrêtent.
- Traitement par lots : les éléments issus d'un même découpage forment un lot ; les rouges sont notés, pas corrigés sur-le-champ ; la fin du lot les traite en une fois ; un rapport par lot.
- Commandes sans surveillance : aucune forme de commande qui déclenche une boîte de confirmation ; supprimer en déplaçant, pas de cd dans les commandes, n'écrire que dans le répertoire de travail.
- Rapport silencieux : aucun rapport tant que le travail est en cours ; on rend compte seulement quand tout est terminé ou que tout ce qui reste est bloqué.
- Autorité et cohérence du design : lire d'abord l'autorité de design du projet et ses spécifications de composants publiées ; les changements de composants et de visuel se font d'abord dans l'autorité et ne sont repris qu'après sa publication ; les composants d'un même type restent cohérents.
- Nettoyage des résidus : qui crée un répertoire temporaire, une copie, un worktree ou un processus d'arrière-plan en répond ; à la fin du lot, même en échec, on les nettoie selon leur usage ; les preuves restent séparées des copies reconstructibles.
- Contrat de rédaction des objectifs : un objectif n'énonce qu'un état final vérifiable, jamais une autorisation ; chacun porte l'issue « bloqué sur une décision que vous seul pouvez prendre ».

## Plusieurs appareils et dossiers cloud

`Ether` est le nom du dossier de la bibliothèque partagée. Vous choisissez son dossier parent : disque local, disque externe ou dossier synchronisé comme OneDrive ou iCloud. Les projets sont distingués par leur identité dans une seule bibliothèque ; les projets suivants réutilisent cet emplacement par défaut. Les événements sont dans `akasha/<id-appareil>/` ; caches, verrous et sauvegardes dans `Ether/.einzbern/<id-appareil>/`, séparément pour chaque appareil. Identité, registre, configuration des hôtes et moteurs installés restent en local dans `~/.einzbern/`. Les bibliothèques `.ether` existantes restent compatibles.

## Comment nous l'utilisons nous-mêmes

C'est ainsi qu'Einzbern se développe lui-même, et c'est l'usage que nous suggérons. Vous pouvez n'en adopter qu'une couche.

**Deux conversations.** Une conversation de conception, sur le palier phare, discute la direction avec vous, enregistre les décisions en comptes rendus et découpe le travail en Initiative, Epic et Story dans Ether. Une conversation d'implémentation, sur le palier principal, lit les Stories dans Ether et n'écrit aucun code : elle délègue, enregistre, exécute les portes et rend compte.

**Un lot à la fois.** La conversation d'implémentation envoie un sous-agent du palier économique découper d'un coup toutes les Stories de l'Initiative en Subtasks, chacune nommant les fichiers touchés et ses dépendances. Puis elle forme des paquets par dépendance et chevauchement de fichiers : les Subtasks liées vont dans un même paquet, dans l'ordre ; les indépendantes forment chacune leur paquet. Chaque paquet reçoit un sous-agent du palier économique qui travaille dans son propre worktree git, en parallèle, et se retire une fois le paquet fini. Quand tous les paquets sont finis, un sous-agent d'intégration les fusionne dans l'ordre des dépendances ; les portes tournent une fois et l'acceptation a lieu une fois en fin de lot, et les défauts sont repris par lot.

**Les quatre principes de l'époque activés.** Fonctionnement autonome : les actions réversibles se font simplement. Traitement par lots : les rouges sont notés, pas corrigés sur-le-champ, et traités une fois en fin de lot. Commandes sans surveillance : aucune forme de commande qui déclenche une boîte de confirmation. Rapport silencieux : on rend compte seulement quand tout est terminé ou que tout ce qui reste est bloqué.

**Vous n'apparaissez qu'à deux moments.** Pour décider dans la conversation de conception, et pour lire un rapport quand la conversation d'implémentation clôt un lot, avec chaque point en attente de votre décision listé d'un coup, accompagné d'une recommandation.

### Abonnements et paliers de modèles (au 2026-09-26)

Abonnements suggérés : Claude Max 5x ou ChatGPT Pro 5x. Réglez le plafond de sous-agents parallèles selon l'abonnement ; au-delà de la valeur suggérée, le quota hebdomadaire fond trop vite. Le plafond est execution.maxConcurrentSubagents dans Atelier.

| Abonnement | Plafond de sous-agents parallèles |
|---|---|
| Claude Pro ou ChatGPT Plus | 1 ou 2 |
| Claude Max 5x ou ChatGPT Pro 5x | 3 |
| Plans 20x | 8 ou plus |

Plus de parallélisme n'est pas toujours mieux ; quand le quota s'épuise, il doit se réduire de lui-même. Quatre variables système décident du moment, toutes modifiables dans Atelier :

| Variable | Défaut | Signification |
|---|---|---|
| quota.fiveHourParallelOffPercent | 75 | À ce pourcentage du quota de 5 heures, le plafond de sous-agents parallèles tombe à 1 |
| quota.fiveHourWaitPercent | 90 | À ce pourcentage du quota de 5 heures, plus aucun sous-agent n'est délégué jusqu'à la réinitialisation de la fenêtre |
| quota.weeklyParallelOffPercent | 95 | À ce pourcentage du quota hebdomadaire, le plafond de sous-agents parallèles tombe à 1 |
| quota.weeklyWaitPercent | non défini | Pas de seuil d'attente sur le quota hebdomadaire ; il ne s'applique que si vous le définissez |

Le tableau ci-dessous est celui que nous utilisons en ce moment ; les noms de modèles vieillissent au rythme des éditeurs, alors le models.tiers que vous maintenez dans Atelier fait foi.

| Hôte | Phare | Principal | Économique |
|---|---|---|---|
| Claude Code | claude-fable-5-1, max, conversation de conception seulement, jamais délégué | claude-opus-5-5, max, orchestration des sous-agents et acceptation | claude-opus-5-5, low, découpage et implémentation des paquets |
| Codex | gpt-6-astra, max | gpt-6-sol, max | gpt-6-luna, max |

## Comment les principes intégrés font durer vos tokens

Les quatre principes de l'époque ne sont pas seulement une discipline ; chacun bouche une fuite mesurée. Les chiffres viennent du journal de développement d'Einzbern lui-même, 2026-09-26, même lot de travail, même modèle.

| Où ça fuit | Mesuré | Le principe qui bouche |
|---|---|---|
| Un sous-agent tourne sans fin, son contexte grossit et il le relit entièrement à chaque tour | Un sous-agent pour 30 Subtasks : contexte moyen 526k, 3 740 tours, 221M de tokens pondérés, 7,4M par Subtask | Traitement par lots : des paquets en parallèle, un sous-agent neuf par paquet, retiré une fois fini. Un sous-agent de paquet neuf coûte 2,9M par Subtask, 39 % de cela |
| Corriger un rouge dès qu'il apparaît, puis un autre, et relancer les portes sans fin | Dans la version précédente, neuf tickets de défaut ont tourné autour d'une porte de budget, et un défaut de hook a pris quatre commits | Traitement par lots : les rouges sont notés, pas corrigés sur-le-champ ; traités une fois en fin de lot ; une cause racine compte une fois |
| Lancer une vague juste à la fin d'une fenêtre de quota, et tout perdre | Huit sous-agents parallèles ont rempli le quota de 5 heures en 12 minutes, zéro commit, environ 15M perdus | Garde de quota : lire le quota avant de déléguer ; le parallélisme baisse à 75 %, l'attente commence à 90 % |
| Une boîte de confirmation s'ouvre et la session attend un humain indéfiniment | Une attente a duré 2 heures 12 minutes | Commandes sans surveillance : aucune forme de commande qui ouvre une boîte |
| La conversation principale écrit un rapport après chaque délégation | Quelques milliers de tokens à chaque fois, tous gardés dans le contexte principal et relus à chaque tour ensuite | Rapport silencieux : rendre compte seulement quand tout est terminé ou tout est bloqué |
| Demander « je continue ? » et attendre la réponse | Sans personne présent, l'attente dure toute la nuit | Fonctionnement autonome : les actions réversibles se font simplement |

Quatre-vingts à quatre-vingt-dix pour cent du coût, ce sont les lectures de cache, c'est-à-dire la relecture du contexte à chaque tour. Le prompt système et les règles injectés au démarrage d'un sous-agent ne font que 52k, moins de 1 % du coût d'un sous-agent. Économiser des tokens ne consiste donc pas à injecter moins, mais à garder le contexte de chaque sous-agent court et ses tours peu nombreux : un fichier d'extrait par paquet plutôt que tout le découpage, la sortie des commandes écrite dans des fichiers dont on ne relit que la fin, les gros fichiers lus par plages, les commandes voisines fusionnées. Tout cela est écrit dans le principe de traitement par lots et dans le fichier de démarrage de la conversation d'implémentation.

Le parallélisme en lui-même n'économise aucun token ; il change seulement la vitesse à laquelle ils partent. Ce qui économise, c'est un contexte neuf. C'est pourquoi le plafond parallèle suit votre abonnement et la garde de quota le réduit d'elle-même quand le quota s'épuise.

## Pourquoi cette conception

**Fournir la mémoire, ne pas policer la méthode.** La version précédente a tenté d'enfermer le modèle avec des portes, des preuves et des hooks Stop : plus d'une centaine de verbes, seize portes. Nous l'avons utilisée nous-mêmes pendant deux mois. Le coût dépassait de loin le bénéfice, et le modèle oubliait quand même ce qu'il allait oublier. Cette version retire tout cela et garde les enregistrements et la recherche.

**Un seul hook.** Un modèle ne sait pas ce qu'il ne sait pas ; la recherche doit donc être déclenchée par l'hôte avant chaque prompt, sans attendre que le modèle y pense. Mais le hook ne contient aucune règle. Quoi chercher et combien en donner, c'est le moteur qui décide.

**AGENTS.md est votre fichier.** Des règles qui doivent valoir sur les deux hôtes ne peuvent vivre que là où les deux lisent. Einzbern y écrit donc, mais seulement des sections balisées, seulement ce que vous avez activé, et jamais par-dessus vos modifications.

**N'indexer que les Stories.** Les Initiatives et les Epics sont trop grossières, les Subtasks trop fines. Ce qu'il faut savoir, une Story le dit.

**Des enregistrements en ajout seul.** Tout état dérivé peut être reconstruit à partir des enregistrements. C'est pour cela que les index peuvent rester locaux et que les appareils peuvent fusionner.

**Une configuration à deux niveaux.** La configuration du projet voyage avec les enregistrements ; celle de l'appareil reste sur la machine. Installer un nouvel appareil, c'est configurer l'appareil, pas le projet.

## Glossaire

| Nom | Ce que c'est | D'où vient le nom |
|---|---|---|
| Einzbern | Le moteur : le programme qui détient les enregistrements et exécute recherche et enregistrement | Le corps du Graal |
| Mana Orchestrate | Le skill qui amène Einzbern dans l'hôte : indique au modèle quand appeler quelle fonction du moteur, et embarque l'assistant d'installation | Le mana, la grande source d'énergie magique ; ici, la mémoire en circulation |
| Ether | Le répertoire des artefacts `Ether` | L'éther, le milieu qui permet au mana de prendre forme dans le monde réel |
| Akasha | `Ether/akasha/`, l'enregistrement d'événements en ajout seul dont tout état dérivé est reconstruit | Akasha, la Racine, où résident tous les enregistrements |
| Crest | `Ether/crest/`, le dépôt de connaissances ; les dépôts de projet et d'utilisateur portent le même nom | L'emblème magique, l'art hérité de génération en génération |
| Command Spell | Les sept principes intégrés, désactivés par défaut, activés au choix | Les sceaux de commandement auxquels un Servant ne peut se soustraire |
| Atelier | La page de gestion locale | L'atelier d'un mage |

## Documentation complète

Wiki : concepts et glossaire, assistant d'installation, structure de `Ether`, plusieurs appareils et dossiers cloud, texte intégral des principes, migration depuis TCRN Workflow, référence CLI.

## Licence

Apache-2.0
