<div align="center">

# Einzbern

Le Graal exauce les vœux. Einzbern se souvient des vœux que vous avez formulés, des décisions que vous avez prises et des pièges dans lesquels vous êtes tombé,<br>et les place devant le modèle juste avant le prompt qui en a besoin.

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Français**

![release](https://img.shields.io/badge/release-4.4.1-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

[Ce qui s'est passé mercredi après-midi](#ce-qui-sest-passé-mercredi-après-midi) · [Ce qu'il retient](#ce-quil-retient) · [Quand vous en aurez envie](#quand-vous-en-aurez-envie) · [Pourquoi lui, et pas un plugin de mémoire](#pourquoi-lui-et-pas-un-plugin-de-mémoire) · [Installation](#installation) · [Au quotidien](#au-quotidien) · [Plusieurs appareils et dossiers cloud](#plusieurs-appareils-et-dossiers-cloud) · [Comment nous l'utilisons nous-mêmes](#comment-nous-lutilisons-nous-mêmes) · [Comment nous réduisons votre consommation](#comment-nous-réduisons-votre-consommation) · [Pourquoi cette conception](#pourquoi-cette-conception) · [Glossaire](#glossaire)

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

Le tableau ci-dessous conserve un exemple de configuration des modèles ; ce ne sont ni des valeurs par défaut ni des associations fixes du workflow. Les modèles et l'effort de raisonnement effectifs dépendent du models.tiers que vous maintenez dans Atelier.

| Hôte | Phare | Principal | Économique |
|---|---|---|---|
| Claude Code | claude-fable-5-1, max, conversation de conception seulement, jamais délégué | claude-opus-5-5, max, orchestration des sous-agents et acceptation | claude-opus-5-5, low, découpage et implémentation des paquets |
| Codex | gpt-6-astra, max | gpt-6-sol, max | gpt-6-luna, max |

## Comment nous réduisons votre consommation

> **Le workflow dédié à Codex est disponible.** Codex Desktop utilise deux conversations indépendantes : une de décision au palier principal et une de coordination au palier économique. Les autres hôtes conservent leurs parcours natifs. Les coûts ci-dessous ont été calculés le 2026-10-31 à partir d'échantillons historiques ; ces comparaisons reposent sur des hypothèses d'estimation et ne promettent pas une économie de quota fixe.

Les tâches longues consomment des ressources au-delà de l'écriture du code. La délégation, la reprise après une attente, la récupération de l'état, la lecture des journaux et la réception des résultats des sous-agents peuvent toutes amener le modèle à traiter le contexte à répétition. Einzbern et Mana Orchestrate contrôlent ces coûts par la répartition des tâches, les limites des lots et le périmètre du contexte.

- **Choisir la catégorie de modèle selon la tâche.** La planification, les jugements complexes et l'acceptation indépendante commencent au palier principal ; l'exécution bien délimitée et la coordination courante utilisent le palier économique configuré. La politique de l'hôte détermine le modèle et l'effort de raisonnement effectifs, sans imposer un modèle fixe.
- **Exécuter un objectif par lot entier.** Après le découpage, les tâches sont regroupées selon leurs dépendances. Les agents exécutants terminent leur travail ; l'acceptation et le traitement des problèmes sont regroupés en fin de lot, ce qui réduit les échanges répétés de clôture, de délégation et d'acceptation pour chaque élément.
- **Ne lire que le nécessaire.** Les problèmes et les preuves restent dans les dossiers du lot. La conversation principale reçoit les résultats et les emplacements des preuves utiles à ses décisions ; les gros fichiers, journaux et plans sont lus par extraits.
- **Compter tous les rôles dans le coût.** La conversation principale, les conversations de coordination économique et les agents exécutants sont comptés ensemble, échecs, nouvelles tentatives et retours compris. Une baisse de consommation de la conversation principale s'évalue au regard du workflow entier.

### Une coordination adaptée à chaque hôte

| Hôte | Méthode | Objectif d'optimisation et éléments observés |
| :--- | :--- | :--- |
| **Codex Desktop : workflow dédié à deux conversations** | Une conversation de décision indépendante au palier principal transmet l'objectif du lot entier. Une conversation indépendante au palier économique délègue aux sous-agents exécutants, attend et recueille leurs résultats, puis fait un seul retour au palier principal en fin de lot. | Les exécutions historiques montrent un coût sensible lorsque la coordination fréquente reste dans une longue conversation au palier principal. Confier ce travail au palier économique permet de contrôler la fréquence des appels à la conversation principale. |
| **Claude Code : parcours natif conservé** | Une seule conversation principale coordonne les sous-agents exécutants avec l'exécution en arrière-plan et les notifications de fin de l'hôte. | Les notifications natives ramènent les résultats. Les optimisations portent ensuite sur les catégories de modèles, les réveils programmés, le contenu retourné et le rythme d'acceptation. Les échantillons actuels ne démontrent pas un besoin général de conversation de coordination distincte. |
| **DeepSeek Harness : parcours natif conservé** | Une seule conversation principale utilise les sous-agents gérés par le runtime ; le plugin Mana Orchestrate assure l'intégration de la mémoire et la déduplication du pont. | Le runtime gère les notifications de fin et la libération des ressources. Les journaux historiques montrent déjà plusieurs retours regroupés dans une seule réponse principale. Les optimisations supplémentaires s'évaluent selon les modèles réels et la part du coût de coordination. |

Cette forme à deux conversations est **l'unique workflow Codex** ; elle remplace l'ancien parcours fondé sur le hook collecteur, sans modifier les autres hôtes. La coordination économique reçoit directement les résultats des exécutants, sans agent collecteur distinct. L'implémentation, l'intégration et l'acceptation indépendante incombent aux agents exécutants correspondants. Les catégories principale et économique sont obligatoires ; la catégorie phare est facultative.

Le modèle réalise cette orchestration avec les outils de l'hôte. Le moteur enregistre les lots et les reçus ; il ne crée pas lui-même de conversations, ne délègue pas de tâches et n'envoie pas de messages.

Codex prend lui-même en charge les sous-agents, l'attente et l'agrégation des résultats. Le workflow dédié répond aux coûts de coordination observés. Conserver les parcours natifs de CC et DSH ne signifie pas qu'ils n'ont aucun retraitement du contexte lors des retours ni qu'ils n'auront jamais besoin d'optimisation. Voir les documentations des [sous-agents Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents), des [sous-agents Claude Code en arrière-plan](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) et de la [délégation native DSH](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md).

### Un cas Codex : trois méthodes estimées à consommation identique sur 29,3 heures

Un journal de développement de design system couvre **29,3 heures, 81 conversations et 7 763 réponses uniques du modèle**, décisions principales, coordination économique et ensemble des exécutants compris. Le travail était encore en cours à la fin de l'échantillonnage. Les chiffres décrivent cette fenêtre, pas le coût complet d'une livraison ayant passé l'acceptation finale.

| Méthode | Credits de référence Standard | Coordination principale = 100 % | Nature des données |
| :--- | ---: | ---: | :--- |
| **Décision principale + coordination économique + exécutants affectés par catégorie** | **2 610,58** | **49,3 %** | Requêtes et consommation observées, valorisées au tarif du modèle réel de chaque réponse |
| Le palier principal assure toute la coordination et l'attente ; les exécutants restent identiques | Environ 5 300,52 | 100 % | Requêtes, tokens et composition du cache inchangés ; coordination économique recalculée au tarif du modèle principal |
| Aucun sous-agent ; toute l'exécution revient à la conversation principale | Environ 5 116,83 | 96,5 % | Communications exclusivement entre agents identifiables retirées, puis travail conservé recalculé au tarif principal |

Avec ces hypothèses, les deux conversations coûtent environ **50,7 %** de moins que la coordination principale, et **49,0 %** de moins que l'exécution par le seul modèle principal. Dans le coût de référence cumulé, les exécutants représentent **80,5 %**, la décision principale **10,8 %** et la coordination économique **8,7 %**.

Le modèle principal de comparaison est GPT-6.1 Sol. Les journaux observés comprennent aussi GPT-6 Luna et un peu de GPT-6.1 Terra. Ces noms sont des conditions de mesure du cas, pas des modèles imposés par le produit. Les tarifs de référence proviennent de la [page officielle OpenAI Pricing](https://learn.chatgpt.com/docs/pricing).

**50,7 % est l'écart obtenu en changeant le tarif de toute la coordination à consommation identique.** Cela couvre la délégation, l'attente, la récupération, la collecte des résultats et les rapports. On ne peut pas écrire que « les retours par lots ont à eux seuls réduit les tokens de 50,7 % ». Aucune des deux alternatives n'a été réexécutée ; les écarts de croissance du contexte, de cache, de durée séquentielle et de qualité de livraison restent inconnus.

### Quel contexte la conversation principale traite-t-elle après le retour d'un sous-agent ?

Compter seulement les outils de délégation et d'attente omet le traitement qui suit la réception des résultats. Nous comptons aussi la première réponse unique mesurée après un retour. Plusieurs retours réunis dans une seule réponse sont comptés une fois ; les blocs de contenu diffusés en streaming ne sont pas comptés à nouveau. Cela mesure le traitement proche d'un retour, sans prouver que la notification seule a causé tout le coût de la réponse.

| Échantillon / rôle | Événements de retour reçus | Premières réponses de réception | Entrée moyenne par réponse, cache compris | Part des lectures de cache |
| :--- | ---: | ---: | ---: | ---: |
| CC : quatre conversations principales | 212 notifications de fin | **207** | Environ 636k tokens | 96,5 % |
| DSH : conversation principale Pro officielle | 112 notifications de fin + 69 transmissions de résultats | **120** | Environ 395k tokens | 99,1 % |
| Codex : conversation de décision principale | 12 rapports de fin de lot | **12** | Environ 272k tokens | 98,2 % |
| Codex : tous les niveaux de coordination économique | 78 retours finaux + 9 messages d'agents | **87** | Environ 165k tokens | 97,8 % |

Les 112 notifications de fin de DSH correspondent à elles seules à **61** premières réponses de réception : le parcours existant regroupe donc déjà les retours. Les transmissions séparées de résultats déclenchent aussi des réponses, pour un total de 120.

Le niveau économique de Codex reçoit encore les retours individuels ; la conversation principale reçoit les rapports de fin de lot. Les requêtes et les coûts des deux niveaux sont tous comptés. Les tâches, durées et modèles du tableau diffèrent : soustraire les nombres de réponses ou les volumes d'entrée ne permet pas de déduire un taux d'économie entre hôtes. Les entrées cumulées comprennent aussi les relectures du cache.

### Pourquoi ne pas étendre pour l'instant les deux conversations de Codex à CC et DSH ?

En ajoutant le traitement des retours à la consommation historique de chaque hôte, puis en recalculant le travail sélectionné au tarif économique, on estime le gain potentiel à vérifier. CC est comparé à **Haiku 5.5**, et DSH à **Flash 4.1-1017 officiel**. Aucun modèle supplémentaire n'a réexécuté les tâches.

| Échantillon historique | Écart de coût total après recalcul des vérifications de coordination + premières réponses de réception au tarif économique | Estimation élargie à tout l'intervalle de traitement après retour |
| :--- | ---: | ---: |
| CC : quatre arbres de conversations, Opus 5.5 → Haiku 5.5 | **Environ 3,8 %** | **Environ 6,6 %** |
| DSH : Pro officiel → Flash officiel | **Au plus 6,8 %** | **Au plus 11,2 %** |
| DSH : petit échantillon Flash officiel → Flash au même tarif | **0 % d'écart de tarif du modèle** | **0 % d'écart de tarif du modèle** |

L'estimation élargie va du retour à la prochaine nouvelle délégation, à la fin du tour ou à une saisie utilisateur indépendante. Elle comprend lecture, intégration et jugement. On n'a mesuré ni la possibilité de transférer tout ce travail au palier économique, ni les coûts de démarrage, de transmission, de cache, de qualité et de maintenance d'un niveau de coordination supplémentaire. Les écarts du tableau ne sont pas des économies réalisées.

Les quatre conversations CC donnent séparément environ **2,9 %, 3,0 %, 2,4 % et 11,1 %** ; 3,8 % est le total pondéré. Dans deux échantillons DSH plus récents avec une conversation principale Claude, le recalcul au tarif Flash de la coordination et des premières réponses de réception donne respectivement environ **0,7 %–1,4 %** et **5,3 %–7,8 %**. Le bénéfice dépend du modèle et de la tâche ; aucun taux unique ne peut être promis à tous les projets.

Ces échantillons appuient une optimisation dédiée à deux conversations pour Codex, tandis que CC et DSH conservent leurs parcours natifs et continuent d'examiner les notifications en double, les réveils évitables, le contenu retourné et l'efficacité du cache. Les notifications natives de fin établissent les capacités d'intégration. L'ajout d'une coordination indépendante exige encore des preuves couvrant ses coûts supplémentaires et la qualité de livraison.

### Mesurer séparément l'attente et les appels au modèle qui la suivent

Le temps bloqué dans un outil d'attente ne produit pas à lui seul de nouvelle entrée du modèle. Un nouvel appel après expiration du délai traite à nouveau le contexte et produit une sortie.

Sur ce journal Codex entier, la conversation principale a produit **244 réponses pour 281,14 credits de référence Standard** ; la coordination économique, **4 430 réponses pour 226,68 credits**. Ces deux coûts sont compris dans le total de 2 610,58 credits. Les 12 réponses désignent seulement les premières réponses après les rapports de fin de lot, pas tous les appels de la conversation principale.

Le niveau économique compte encore **567 réponses mesurées après expiration d'une attente**, traitant environ **91,81 millions de tokens d'entrée**, dont environ **98,9 %** de lectures de cache, pour **26,95 credits de référence**. Ce cas montre l'avantage tarifaire du transfert des reprises fréquentes vers un modèle économique, ainsi qu'une marge pour réduire les reprises après expiration. Il ne permet pas d'affirmer que toute interrogation à vide a disparu.

<details>
<summary><b>Périmètre des échantillons, tarifs et limites des estimations</b></summary>
<br>

**Périmètre.** La fenêtre Codex va du 2026-10-29 à 21:28:39 au 2026-10-31 à 02:46:01, heure de Chine (UTC+8), et couvre deux conversations indépendantes et tous leurs exécutants natifs. Les autres projets, le développement du workflow et cet audit de consommation en sont exclus. L'échantillon CC comprend 4 conversations principales, 210 journaux de sous-agents et 27 767 réponses uniques. DSH comprend 4 arbres de conversations, 115 sessions et 4 672 réponses de différents mois et parcours de modèles. Les journaux privés d'origine ne sont pas publiés avec cette explication.

**Évolution dans le temps.** Les premières 11,6 heures Codex coûtent 932,03 credits de référence, soit une baisse estimée de 58,5 % par rapport à la coordination principale à consommation identique. Les 17,7 heures suivantes coûtent 1 678,55 credits, avec une baisse de 45,1 % ; le cumul atteint 50,7 %. Le seul recalcul du travail de coordination donne un écart de tarif d'environ 92,2 % ; ce n'est pas une baisse du workflow entier.

**Calcul des trois méthodes Codex.** La comparaison avec la coordination principale conserve la fréquence de requêtes, les tokens et la composition du cache observés, et change seulement le tarif des fonctions de coordination économique. La comparaison sans sous-agents retire 1 083 réponses identifiables consacrées exclusivement à la délégation, l'attente, les requêtes d'état et les communications entre agents. Elle conserve les lectures de gouvernance, l'implémentation, l'intégration, la validation et l'attente de processus. Le contexte de démarrage répété qui ne peut pas être isolé de façon fiable reste compté. Le cache, la durée séquentielle et la qualité de l'acceptation indépendante dans une conversation unique longue n'ont pas été mesurés.

**Comptage après retour.** Les notifications CC de commandes en arrière-plan et de sous-agents sont distinguées ; les relations entre messages parents permettent de vérifier les réponses suivantes. Les autres hôtes sont associés selon l'ordre des événements natifs. Les corps complets des requêtes ne permettent pas une réexécution uniforme entre hôtes : la « première réponse mesurée après retour » ne signifie donc pas que chaque token a été causé par ce seul événement. Les candidats de coordination CC comprennent aussi les vérifications programmées, de notification et de surveillance en arrière-plan identifiées séparément. DSH comprend la coordination d'agents identifiable et les premières réponses après notifications de fin ou transmissions de résultats. Les sélections qui se chevauchent ne sont comptées qu'une fois.

**Date des tarifs et unités.** Les tarifs ont été consultés le 2026-10-31. Codex utilise les [credits de référence Standard officiels](https://learn.chatgpt.com/docs/pricing), Claude les [tarifs officiels Global Standard API](https://platform.claude.com/docs/en/about-claude/pricing), et DeepSeek les [tarifs officiels actuels hors pointe](https://api-docs.deepseek.com/quick_start/pricing/). Les factures historiques aux heures de pointe ou jours fériés n'ont pas été reconstituées. Les valeurs de référence tarifaires des API des différents hôtes et les credits Codex ne forment pas une monnaie unique ; elles ne sont pas non plus les factures réelles ou les quotas hebdomadaires d'abonnement.

**Cache et données manquantes.** Selon la [tarification officielle de Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), une requête dont l'entrée complète dépasse 100k tokens utilise le tarif supérieur ; le seuil inclut lectures et écritures du cache. Le palier a été déterminé pour chaque requête. Le tarif de 7 réponses Qwen de l'arbre DSH Pro est inconnu et n'a pas été supposé nul : les pourcentages de l'arbre entier sont donc des bornes supérieures. Certaines écritures du cache Claude dans DSH n'ont pas de durée connue ; un intervalle fondé sur les tarifs de 5 minutes et 1 heure est conservé. Les frais réels de tiers ne sont pas vérifiés. Le raisonnement est inclus dans la sortie et n'est pas facturé deux fois.

**Sens des bornes.** Recalculer tout le travail des conversations principales donne une borne supérieure arithmétique d'environ 15,2 % pour CC avec Haiku et une borne supérieure sur l'arbre entier d'environ 30,7 % pour DSH Pro avec Flash. Cela comprend planification, implémentation, jugements décisifs et acceptation ; tous ces travaux ne sont pas pour autant adaptés à un modèle économique. Les 0 % de Flash au même tarif signifient uniquement qu'il n'y a pas de différence de prix du modèle ; moins de requêtes ou un meilleur contexte peuvent encore apporter un bénéfice.

**Qualité et causalité.** Toutes les comparaisons de coût recalculent statiquement des consommations historiques, sans réexécution contrôlée de la même tâche. Le taux d'économie causal obtenu en réduisant le contexte répété, en changeant de modèle ou en ajoutant une coordination reste inconnu. Le parallélisme et les sous-agents supplémentaires peuvent accélérer l'exécution, mais aussi ajouter démarrage, communication et reprises. L'économie s'évalue avec la consommation de tous les rôles, le délai d'achèvement et la qualité de livraison.

</details>

### Comment les principes intégrés font durer vos tokens

Les quatre principes de l'époque ne sont pas seulement une discipline ; chacun bouche une fuite mesurée. Les chiffres viennent du journal de développement d'Einzbern lui-même, 2026-09-26, même lot de travail, même modèle.

| Où ça fuit | Mesuré | Le principe qui bouche |
|---|---|---|
| Un sous-agent tourne sans fin, son contexte grossit et il le relit entièrement à chaque tour | Un sous-agent pour 30 Subtasks : contexte moyen 526k, 3 740 tours, 221M de tokens pondérés, 7,4M par Subtask | Traitement par lots : des paquets en parallèle, un sous-agent neuf par paquet, retiré une fois fini. Un sous-agent de paquet neuf coûte 2,9M par Subtask, 39 % de cela |
| Corriger un rouge dès qu'il apparaît, puis un autre, et relancer les portes sans fin | Dans la version précédente, neuf tickets de défaut ont tourné autour d'une porte de budget, et un défaut de hook a pris quatre commits | Traitement par lots : les rouges sont notés, pas corrigés sur-le-champ ; traités une fois en fin de lot ; une cause racine compte une fois |
| Lancer une vague juste à la fin d'une fenêtre de quota, et tout perdre | Huit sous-agents parallèles ont rempli le quota de 5 heures en 12 minutes, zéro commit, environ 15M perdus | Garde de quota : lire le quota avant de déléguer ; le parallélisme baisse à 75 %, l'attente commence à 90 % |
| Une boîte de confirmation s'ouvre et la session attend un humain indéfiniment | Une attente a duré 2 heures 12 minutes | Commandes sans surveillance : aucune forme de commande qui ouvre une boîte |
| La conversation principale écrit un rapport après chaque délégation | Quelques milliers de tokens à chaque fois, tous gardés dans le contexte principal et relus à chaque tour ensuite | Rapport silencieux : rendre compte seulement quand tout est terminé ou tout est bloqué |
| Demander « je continue ? » et attendre la réponse | Sans personne présent, l'attente dure toute la nuit | Fonctionnement autonome : les actions réversibles se font simplement |

Dans le calcul du coût pondéré de l'échantillon du 2026-09-26 ci-dessus, les lectures de cache représentaient environ 80–90 % du coût. Le prompt système et les règles injectés au démarrage totalisaient environ 52k, moins de 1 % du coût d'un sous-agent. Ces proportions ne valent que pour cet échantillon historique ; elles ne se généralisent ni aux autres modèles, ni à la consommation actuelle, ni aux quotas d'abonnement. Les extraits par paquet, les sorties de commandes enregistrées dans des fichiers dont seules les parties nécessaires sont relues, la lecture des gros fichiers par plages et le regroupement de commandes voisines étaient les méthodes de contrôle du contexte de ce lot.

Le parallélisme, le nombre d'agents et les limites du contexte peuvent tous modifier la consommation totale. Ce cas appuie le contrôle du contexte et des allers-retours par paquet. Un contexte neuf ou davantage de concurrence ne prouvent pas à eux seuls une économie ; il faut encore vérifier le coût du workflow entier et la qualité de livraison.

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
